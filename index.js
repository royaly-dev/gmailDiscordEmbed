// Bot Discord qui surveille un compte Gmail toutes les 30 minutes.
//
// Principe :
//   1. Si aucun token.json n'existe, le flux OAuth2 est lancé une seule fois
//      pour que tu autorises l'accès à ton Gmail (comme dans l'exemple).
//   2. Une boucle tourne toutes les 30 minutes : elle récupère la liste des
//      mails, la compare à ce qui a déjà été vu, et pour chaque NOUVEAU mail
//      elle envoie un embed Discord (sujet + début du corps + infos) avec
//      deux boutons "Gardé" / "Supprimé" (non fonctionnels pour l'instant).
//
// Configuration : voir .env.example (DISCORD_TOKEN, GMAIL_ACCOUNT, DISCORD_CHANNEL_ID)
// Lancement :  node index.js

import process from "node:process";
import "dotenv/config";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { gmail } from "@googleapis/gmail";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
} from "discord.js";
import { createInterface } from "node:readline/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname);
const CREDENTIALS_PATH = resolve(root, "credentials.json");
const TOKEN_PATH = resolve(root, "token.json");
const SEEN_PATH = resolve(root, "seen.json");
const INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_RESULTS = 50; // nombre de mails récupérés à chaque tour

// ---------------------------------------------------------------------------
// Fichiers de config / auth
// ---------------------------------------------------------------------------

const env = process.env;

/** Lit les identifiants OAuth2 (desktop) depuis credentials.json. */
function loadClientSecrets() {
  const secrets = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf-8"));

  const { client_id, client_secret, redirect_uris } =
    secrets.installed || secrets;
  return {
    client_id,
    client_secret,
    redirect_uris: redirect_uris || ["http://localhost"],
  };
}

/** Relit le secret à chaque tour au cas où le fichier change. */
async function getClient() {
  const { client_id, client_secret, redirect_uris } = loadClientSecrets();
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);

  if (existsSync(TOKEN_PATH)) {
    oauth2.setCredentials(JSON.parse(readFileSync(TOKEN_PATH, "utf-8")));
    return oauth2;
  }

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
  });
  console.log(
    "Aucun token trouvé. Ouvre cette URL pour autoriser l'acces a ton Gmail :\n",
    url,
  );
  const code = (
    await prompt(
      "Colle ici l'URL de redirection (ou le code) apres authentification : ",
    )
  ).trim();
  const redirectMatch = code.match(/[?&]code=([^&]+)/);
  const { tokens } = await oauth2.getToken(
    redirectMatch ? redirectMatch[1] : code,
  );
  oauth2.setCredentials(tokens);
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log("Token sauvegarde dans token.json\n");
  return oauth2;
}

/** Helper de lecture clavier (promesse). */
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).then((answer) => {
    rl.close();
    return answer;
  });
}

// ---------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------

/** Renvoie la liste des ID des N derniers mails. */
async function fetchMailIds(oauth2) {
  const client = gmail({ version: "v1", auth: oauth2 });
  const res = await client.users.messages.list({
    userId: "me",
    query: "in:inbox unread:True", // inbox ET non-lus seulement
    maxResults: MAX_RESULTS,
    orderBy: "reverseTimeOrder",
  });
  return (res.data.messages ?? []).map((m) => m.id);
}

/** Extrait le corps textuel d'un message (gère le multipart / base64url). */
function base64UrlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString("utf-8");
}

function extractBody(payload) {
  if (!payload) return "";
  const type = payload.mimeType || "";
  const subtype = type.split("/").pop().toLowerCase();

  if (type.includes("multipart")) {
    for (const part of payload.parts ?? []) {
      const body = extractBody(part);
      if (body) return body; // on prend le premier (généralement text/plain en premier)
    }
    return "";
  }

  if (subtype !== "plain" && subtype !== "html") return "";
  let text = "";
  try {
    text = base64UrlDecode(payload.body?.data ?? "");
  } catch {
    text = "";
  }
  if (subtype === "html") {
    text = text.replace(/<[^>]*>/g, " "); // on retire les balises HTML
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Extrait la 1re adresse email trouvée dans une chaîne. */
function extractEmail(str) {
  const m = String(str || "").match(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  );
  return m ? m[0].toLowerCase() : "";
}

/** Récupère l'adresse du destinataire (celle des headers Delivered-To). */
function getRecipientEmail(messages) {
  for (const m of messages) {
    const delivered =
      (m.payload?.headers || []).find(
        (h) => h.name.toLowerCase() === "delivered-to",
      )?.value || "";
    const email = extractEmail(delivered);
    if (email) return email;
  }
  return "";
}

/** Récupère les en-têtes + corps de chaque mail (format complet). */
async function getMailDetails(oauth2, ids) {
  const client = gmail({ version: "v1", auth: oauth2 });
  const messages = [];
  for (const id of ids) {
    const res = await client.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    messages.push(res.data);
  }

  // On ne garde QUE les mails réellement adressés à ce compte
  // (exclut CC, bcc, listes de diffusion, mails pour d'autres personnes).
  const myEmail = getRecipientEmail(messages);

  const details = [];
  for (const message of messages) {
    const payload = message.payload || {};
    const headers = payload.headers || []; // <- les headers sont dans payload
    const find = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      "";
    const to = find("To");
    if (myEmail && !to.toLowerCase().includes(myEmail)) continue;

    details.push({
      id: message.id,
      subject: find("Subject") || "(sans sujet)",
      from: find("From") || "(sans expéditeur)",
      date: find("Date") || "(sans date)",
      body: extractBody(payload),
    });
  }
  return details;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/** Construit l'embed d'un nouveau mail. */
function buildEmbed(mail) {
  const subject =
    mail.subject.length > 250 ? `${mail.subject.slice(0, 250)}…` : mail.subject;
  const description = mail.body.trim() || "(aucun corps de message)";
  const bodyPreview =
    description.length > 400 ? `${description.slice(0, 400)}…` : description;

  return new EmbedBuilder()
    .setTitle(`📬 Nouveau mail : ${subject}`)
    .setDescription(
      `**De :** ${mail.from}\n**Le :** ${mail.date}\n**Objet :** ${mail.subject}\n\n${bodyPreview}`,
    )
    .setColor(0x2f3136)
    .setTimestamp();
}

/** Ligne de boutons "Gardé" / "Supprimé" (non fonctionnels pour l'instant). */
function buildButtonRow() {
  const keep = new ButtonBuilder()
    .setLabel("Gardé")
    .setCustomId("mail_keep")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);
  const remove = new ButtonBuilder()
    .setLabel("Supprimé")
    .setCustomId("mail_delete")
    .setEmoji("🗑️")
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(keep, remove);
}

/** Trouve le canal où poster les embeds. */
async function resolveChannel(client) {
  const channelId = env.DISCORD_CHANNEL_ID;
  if (channelId) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) return ch;
  }
  const guild = client.guilds.cache.first();
  if (guild) {
    const text = guild.channels.cache.find((c) => c?.isTextBased()) ?? null;
    if (text) return text;
  }
  throw new Error(
    "Aucun canal Discord accessible. Ajoute DISCORD_CHANNEL_ID à ton .env.",
  );
}

// ---------------------------------------------------------------------------
// Persistance des ID déjà vus (évite de renvoyer les mêmes mails au redémarrage)
// ---------------------------------------------------------------------------

/** Charge les ID déjà vus depuis seen.json (retorne un Set vide si absent). */
function loadSeenIds() {
  try {
    if (!existsSync(SEEN_PATH)) return new Set();
    return new Set(JSON.parse(readFileSync(SEEN_PATH, "utf-8")));
  } catch {
    return new Set();
  }
}

/** Sauvegarde les ID déjà vus dans seen.json. */
function saveSeenIds(seenIds) {
  try {
    writeFileSync(SEEN_PATH, JSON.stringify([...seenIds]));
  } catch (err) {
    console.error(`⚠️ impossible de sauvegarder seen.json : ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Boucle principale
// ---------------------------------------------------------------------------

async function main() {
  const oauth2 = await getClient();
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN est manquant dans ton .env.");

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  let readyPromise;
  client.once(Events.ClientReady, (c) => {
    console.log(`✅ Connecté en tant que ${c.user.tag}`);
  });

  // Gestion des boutons "Gardé" / "Supprimé".
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const mailId = messageToMail.get(interaction.message.id);

    if (interaction.customId === "mail_keep") {
      // "Gardé" : on supprime juste l'embed Discord.
      await interaction.message.delete();
      await interaction.reply({
        content: "✅ Conservé",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === "mail_delete") {
      // "Supprimé" : on supprime l'embed + on déplace le mail dans la corbeille.
      try {
        const client = gmail({ version: "v1", auth: oauth2 });
        await client.users.messages.trash({ userId: "me", id: mailId });
        console.log(`   🗑️ déplacé dans la corbeille : ${mailId}`);
      } catch (err) {
        console.error(`   ⚠️ erreur corbeille pour ${mailId} : ${err.message}`);
      }
      await interaction.message.delete();
      await interaction.reply({
        content: "🗑️ Supprimé (déplacé dans la corbeille)",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  await client.login(token);

  const channel = await resolveChannel(client);
  console.log(`📺 Embeds envoyés sur : ${channel.name} (${channel.id})\n`);

  // ID déjà vus → chargés depuis seen.json pour survivre à un redémarrage.
  const seenIds = loadSeenIds();

  // Lie un message Discord (id) à un ID Gmail, pour les boutons.
  const messageToMail = new Map();

  const runOnce = async () => {
    try {
      const ids = await fetchMailIds(oauth2);
      const newIds = ids.filter((id) => !seenIds.has(id));
      for (const id of ids) seenIds.add(id);
      saveSeenIds(seenIds);

      if (newIds.length === 0) {
        console.log(
          `⏳ ${new Date().toLocaleTimeString()} — aucun nouveau mail.`,
        );
        return;
      }

      console.log(
        `🆕 ${new Date().toLocaleTimeString()} — ${newIds.length} nouveau(x) mail(s).`,
      );
      const mails = await getMailDetails(oauth2, newIds);

      for (const mail of mails) {
        try {
          const sent = await channel.send({
            content: "@everyone",
            embeds: [buildEmbed(mail)],
            components: [buildButtonRow()],
          });
          messageToMail.set(sent.id, mail.id);
          console.log(`   → envoyé : ${mail.subject}`);
        } catch (err) {
          console.error(
            `   ⚠️ échop envoyeur pour ${mail.subject} : ${err.message}`,
          );
        }
      }
    } catch (err) {
      console.error(`⚠️ erreur lors du tour : ${err.message}`);
    }
  };

  await runOnce(); // premier tour immédiat
  setInterval(runOnce, INTERVAL_MS); // puis toutes les 30 minutes

  // Garde le process vivant.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Erreur critique :", err.message);
  process.exitCode = 1;
});
