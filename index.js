// Discord bot that monitors ONE OR MORE Gmail accounts every 30 minutes.
//
// How it works:
//   1. token.json now holds an ARRAY of accounts (instead of a single token).
//      Each entry carries its OAuth tokens, its email address, AND the Discord
//      channel dedicated to it. You can add as many as you want.
//   2. At startup, for every account WITHOUT a valid token, the OAuth2 flow is
//      launched to authorize it (like in the example).
//   3. A loop runs every 30 minutes: for EACH account it fetches the unread
//      inbox mails, compares them with what was already seen (per account), and
//      for every NEW mail it posts a Discord embed to that account's dedicated
//      channel, with two "Keep" / "Remove" buttons.
//
// Configuration: see .env.example (DISCORD_TOKEN)
// Launch:  node index.js

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
const MAX_RESULTS = 50; // number of mails fetched per cycle

const env = process.env;

const now = () => new Date().toLocaleTimeString();

// ---------------------------------------------------------------------------
// Config / auth files
// ---------------------------------------------------------------------------

/** Reads OAuth2 (desktop) secrets from credentials.json. */
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

/**
 * Generates the Google authorization URL (offline + consent -> returns a
 * refresh_token). Used on first launch and whenever Google revokes a token.
 */
function generateAuthUrl() {
  const { client_id, client_secret, redirect_uris } = loadClientSecrets();
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
  });
}

/** Returns true if an error comes from a revoked/expired token on Google's side. */
function isTokenRevoked(err) {
  const text = String((err && (err.error || err.message || "")) || "");
  return /invalid_grant|revok|expired/i.test(text);
}

/**
 * Loads accounts from token.json.
 * Returns an array of accounts, each with:
 *   - OAuth fields (access_token / refresh_token / expiry_date / ...)
 *   - email              : the Gmail address (readable identifier)
 *   - discordChannelId   : the Discord channel to post to for this account
 */
function loadAccounts() {
  try {
    if (!existsSync(TOKEN_PATH)) return [];
    const raw = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    // token.json is always an array of accounts (multi-account).
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((acc, i) => ({
      ...acc,
      email: typeof acc.email === "string" ? acc.email : null,
      discordChannelId:
        typeof acc.discordChannelId === "string" ? acc.discordChannelId : null,
      _index: i, // internal marker, stripped before saving
    }));
  } catch {
    return [];
  }
}

/** Saves accounts into token.json (stripping internal markers). */
function saveAccounts(accounts) {
  try {
    const clean = accounts.map(({ _index, ...acc }) => acc);
    writeFileSync(TOKEN_PATH, JSON.stringify(clean, null, 2));
  } catch (err) {
    console.error(`⚠️ could not save token.json : ${err.message}`);
  }
}

/**
 * Ensures an account has a valid OAuth token (index within the accounts array).
 * If the account already has a refresh_token, its credentials are reused.
 * Otherwise the OAuth2 flow is launched for that account and the token saved.
 */
async function ensureAccountToken(accounts, index) {
  const { client_id, client_secret, redirect_uris } = loadClientSecrets();
  const oauth2 = new OAuth2Client(client_id, client_secret, redirect_uris[0]);
  const acc = accounts[index];

  if (acc && acc.refresh_token) {
    oauth2.setCredentials(acc);
    return oauth2;
  }

  // No refresh token : launch the OAuth2 flow for this specific account.
  const label = (acc && acc.email) || `account #${index + 1}`;
  console.log(`\n🔑 No token for ${label}. Open this URL to authorize access :`);
  console.log(generateAuthUrl());
  const code = (
    await prompt("Paste the redirect URL (or code) after authentication : ")
  ).trim();
  const redirectMatch = code.match(/[?&]code=([^&]+)/);
  const { tokens } = await oauth2.getToken(redirectMatch ? redirectMatch[1] : code);
  oauth2.setCredentials(tokens);
  accounts[index] = {
    ...tokens,
    email: (acc && acc.email) || label,
    discordChannelId: (acc && acc.discordChannelId) || null,
  };
  saveAccounts(accounts);
  console.log(`✅ token saved for ${accounts[index].email}\n`);
  return oauth2;
}

/**
 * Loads accounts; if there are none, creates the first one by asking for the
 * email and its dedicated Discord channel (fresh start).
 */
async function loadOrInitAccounts() {
  const accounts = loadAccounts();
  if (accounts.length > 0) return accounts;

  console.log("📭 No account configured in token.json.");
  const email = (await prompt("Enter the Gmail address to monitor : ")).trim();
  const channelId = (
    await prompt("ID of the Discord channel dedicated to this account : ")
  ).trim();
  const created = [{ email, discordChannelId: channelId || null }];
  saveAccounts(created);
  return created;
}

/** Key-line reader helper (promise). */
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

/** Returns the list of IDs of the last N mails. */
async function fetchMailIds(oauth2) {
  const client = gmail({ version: "v1", auth: oauth2 });
  const res = await client.users.messages.list({
    userId: "me",
    query: "in:inbox unread:True", // inbox AND unread only
    maxResults: MAX_RESULTS,
    orderBy: "reverseTimeOrder",
  });
  return (res.data.messages ?? []).map((m) => m.id);
}

/** Decodes a message body (handles multipart / base64url). */
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
      if (body) return body; // take the first one (usually text/plain first)
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
    text = text.replace(/<[^>]*>/g, " "); // strip HTML tags
  }
  return text.replace(/\s+/g, " ").trim();
}

/** Extracts the first email address found in a string. */
function extractEmail(str) {
  const m = String(str || "").match(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  );
  return m ? m[0].toLowerCase() : "";
}

/** Gets the recipient address (the Delivered-To headers). */
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

/** Gets headers + body of each mail (full format). */
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

  // Only keep mails actually addressed to this account
  // (excludes CC, bcc, mailing lists, mails for other people).
  const myEmail = getRecipientEmail(messages);

  const details = [];
  for (const message of messages) {
    const payload = message.payload || {};
    const headers = payload.headers || []; // <- headers are in payload
    const find = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ??
      "";
    const to = find("To");
    if (myEmail && !to.toLowerCase().includes(myEmail)) continue;

    details.push({
      id: message.id,
      subject: find("Subject") || "(no subject)",
      from: find("From") || "(no sender)",
      date: find("Date") || "(no date)",
      body: extractBody(payload),
    });
  }
  return details;
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/** Builds an embed for a new mail. */
function buildEmbed(mail) {
  const subject =
    mail.subject.length > 250 ? `${mail.subject.slice(0, 250)}…` : mail.subject;
  const description = mail.body.trim() || "(no message body)";
  const bodyPreview =
    description.length > 400 ? `${description.slice(0, 400)}…` : description;

  return new EmbedBuilder()
    .setTitle(`📬 New mail : ${subject}`)
    .setDescription(
      `**From :** ${mail.from}\n**On :** ${mail.date}\n**Subject :** ${mail.subject}\n\n${bodyPreview}`,
    )
    .setColor(0x2f3136)
    .setTimestamp();
}

/** Row of "Keep" / "Remove" buttons. */
function buildButtonRow() {
  const keep = new ButtonBuilder()
    .setLabel("Keep")
    .setCustomId("mail_keep")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);
  const remove = new ButtonBuilder()
    .setLabel("Remove")
    .setCustomId("mail_delete")
    .setEmoji("🗑️")
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(keep, remove);
}

/**
 * Finds where to post for a given account, from its dedicated channel.
 * Fallback : look for the first text channel in the server.
 */
async function resolveChannel(client, channelId) {
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
    `No accessible Discord channel for ${channelId}. Add discordChannelId to this account in token.json.`,
  );
}

// ---------------------------------------------------------------------------
// Persist already-seen IDs (avoid re-sending the same mails on restart)
// Stored PER-ACCOUNT : { "email@gmail.com": [id, ...] }
// ---------------------------------------------------------------------------

/** Loads already-seen IDs from seen.json (empty object if missing). */
function loadSeenMap() {
  try {
    if (!existsSync(SEEN_PATH)) return {};
    const raw = JSON.parse(readFileSync(SEEN_PATH, "utf-8"));
    const map = {};
    for (const [email, ids] of Object.entries(raw)) {
      map[email] = new Set(Array.isArray(ids) ? ids : []);
    }
    return map;
  } catch {
    return {};
  }
}

/** Saves already-seen IDs into seen.json (per-account format). */
function saveSeenMap(map) {
  try {
    const obj = {};
    for (const [email, ids] of Object.entries(map)) {
      obj[email] = [...ids];
    }
    writeFileSync(SEEN_PATH, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error(`⚠️ could not save seen.json : ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  const token = env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is missing from your .env.");

  // 1. Load / authorize each Gmail account.
  let accounts = await loadOrInitAccounts();
  const clients = []; // OAuth client per account (indexed)
  for (let i = 0; i < accounts.length; i++) {
    clients[i] = await ensureAccountToken(accounts, i);
  }
  console.log(
    `📬 ${accounts.length} account(s) configured : ${accounts
      .map((a) => a.email || "(no email)")
      .join(", ")}`,
  );

  // 2. Discord client (shared across all Gmail accounts).
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    partials: [Partials.Channel],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`✅ Connected as ${c.user.tag}`);
  });

  // Handle "Keep" / "Remove" buttons.
  // messageToMail links a Discord message -> { mailId, oauth2 } of the right account.
  const messageToMail = new Map();
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const entry = messageToMail.get(interaction.message.id);

    if (interaction.customId === "mail_keep") {
      // "Keep" : just delete the Discord embed.
      await interaction.message.delete();
      await interaction.reply({
        content: "✅ Kept",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.customId === "mail_delete") {
      // "Remove" : delete the embed + move the mail to trash.
      try {
        if (!entry) {
          await interaction.reply({
            content: "ℹ️ This mail is no longer in memory.",
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        const gmailClient = gmail({ version: "v1", auth: entry.oauth2 });
        await gmailClient.users.messages.trash({
          userId: "me",
          id: entry.mailId,
        });
        console.log(`   🗑️ moved to trash : ${entry.mailId}`);
      } catch (err) {
        console.error(`   ⚠️ trash error : ${err.message}`);
      }
      await interaction.message.delete();
      await interaction.reply({
        content: "🗑️ Removed (moved to trash)",
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  await client.login(token);

  // 3. Resolve the dedicated channel of each account.
  const channels = {}; // email -> Discord channel
  for (const acc of accounts) {
    const email = acc.email || "(no email)";
    if (!acc.discordChannelId) {
      console.warn(
        `⚠️ ${email} : no discordChannelId — no embed sent for this account.`,
      );
      continue;
    }
    try {
      channels[email] = await resolveChannel(client, acc.discordChannelId);
      console.log(`📺 ${email} -> ${channels[email].name} (${channels[email].id})`);
    } catch {
      console.warn(
        `⚠️ ${email} : Discord channel ${acc.discordChannelId} inaccessible — embed skipped.`,
      );
    }
  }

  // 4. Already-seen IDs -> loaded from seen.json (per-account) to survive a restart.
  const seenMap = loadSeenMap();

  // Report a token revocation only ONCE (avoid spamming errors every 30 min).
  const revokedAccounts = new Set();

  // 5. Loop over every account on each cycle.
  const runCycle = async () => {
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      const channel = channels[acc.email];
      if (!channel) continue; // no valid channel for this account

      let ids;
      try {
        ids = await fetchMailIds(clients[i]);
        // token works again -> clear any possible "revoked" marker
        revokedAccounts.delete(acc.email);
      } catch (err) {
        // Google revoked/expired the refresh_token -> handle it cleanly.
        if (isTokenRevoked(err)) {
          if (revokedAccounts.has(acc.email)) {
            continue; // already reported, don't spam every 30 min
          }
          revokedAccounts.add(acc.email);
          console.log(
            `\n🔒 ${acc.email} : the Gmail token was revoked/expired by Google ` +
              `(invalid_grant). Re-authenticate it once via this URL :`,
          );
          console.log(generateAuthUrl());
          console.log(
            "   (Once done, the bot resumes work on the next cycle.)\n",
          );
          continue;
        }
        // Other error (network, quota, ...) -> retry next cycle.
        console.error(`⚠️ error for ${acc.email} : ${err.message}`);
        continue;
      }

      const seen =
        seenMap[acc.email] || (seenMap[acc.email] = new Set());
      const newIds = ids.filter((id) => !seen.has(id));
      for (const id of ids) seen.add(id);
      saveSeenMap(seenMap);

      if (newIds.length === 0) {
        console.log(`⏳ ${now()} — ${acc.email} : no new mail.`);
        continue;
      }

      console.log(
        `🆕 ${now()} — ${acc.email} : ${newIds.length} new mail(s).`,
      );
      const mails = await getMailDetails(clients[i], newIds);

      for (const mail of mails) {
        try {
          const sent = await channel.send({
            content: "@everyone",
            embeds: [buildEmbed(mail)],
            components: [buildButtonRow()],
          });
          messageToMail.set(sent.id, { mailId: mail.id, oauth2: clients[i] });
          console.log(`   → sent : ${mail.subject}`);
        } catch (err) {
          console.error(
            `   ⚠️ send error for ${mail.subject} : ${err.message}`,
          );
        }
      }
    }
  };

  await runCycle(); // first cycle immediately
  setInterval(runCycle, INTERVAL_MS); // then every 30 minutes

  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Critical error :", err.message);
  process.exitCode = 1;
});
