# gmailDiscordEmbed

A small Discord bot that connects to a Gmail account, reads its inbox, and posts
an embed on Discord for every new mail.

Each embed shows the subject, sender, date and a preview of the message body, and
comes with two buttons: **Kept** (removes the embed) and **Removed** (removes the
embed and moves the mail to Gmail's trash).

## Features

- 🔒 **OAuth2** authentication with the Gmail API (no credentials stored in code).
- 📥 Monitors the **inbox**, only for mails **addressed to you** and **not yet read**.
- 🔁 Re-checks every **30 minutes** and skips mails it has already sent.
- 💬 Posts an embed per new mail with a **@everyone** ping.
- 🗑️ Interactive buttons: **Kept** / **Removed** (trash the mail).
- 💾 Remembers which mails were already sent (`seen.json`) so a restart doesn't
  re-send everything.

## How it works

```
Gmail  ──(Gmail API, OAuth2)──▶  bot (loop every 30 min)  ──(discord.js)──▶  Discord channel
```

On every cycle the bot:

1. Fetches the unread inbox mails addressed to the account.
2. Compares their IDs with the ones it has already seen.
3. For each **new** mail, posts an embed to the configured Discord channel.

## Requirements

- **Node.js** 18+
- A **Discord bot** token
- A **Google Cloud** project with the Gmail API enabled

## Dependencies

- **discord.js** — connects to Discord and sends embeds/interactive messages.
- **@googleapis/gmail** — official client for the Gmail API.
- **google-auth-library** — handles the OAuth2 flow.
- **dotenv** — reads environment variables from a `.env` file (optional).

## Installation

```bash
npm install
```

## Gmail setup (OAuth2)

The Gmail API requires OAuth2 authentication. Steps:

1. Create a project on [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Gmail API** for that project.
3. Create an **OAuth 2.0 Client ID** credentials (type _Desktop_ or _Web application_).
4. Download the `credentials.json` file (client id + client secret) into the project root.
5. Authorize a Gmail account. The bot does this automatically on first run: it prints
   an authorization URL, you open it, and it saves the token to `token.json`.

> The bot requests the **`gmail.modify`** scope because it needs to be able to move
> mails to the trash. It reads the inbox and writes the trash only.

## Discord setup

Create a `.env` file in the project root (or set these as environment variables):

```env
DISCORD_TOKEN=your_bot_token
DISCORD_CHANNEL_ID=your_channel_id
```

- Get the bot token at <https://developers.discord.com/> (Application → Bot → Token).
- To get a channel ID: enable **Developer Mode** in Discord settings, right-click the
  channel, and copy the ID.

> Note: environment variables are also read directly, so you can set them in your
> hosting platform (e.g. Dockploy) instead of using a `.env` file.

## Running locally

```bash
npm start
```

On first run, if there is no `token.json` yet, the bot prints an authorization URL.
Open it in your browser, accept the permissions, then paste the redirect URL (or code)
back into the terminal.

## Buttons

| Button         | Action                                                     |
| -------------- | ---------------------------------------------------------- |
| ✅ **Kept**    | Deletes the embed only. The mail stays as-is in Gmail.     |
| 🗑️ **Removed** | Deletes the embed **and** moves the mail to Gmail's trash. |

> "Trash" means the mail goes to Gmail's Trash folder (recoverable for 30 days), it
> is not permanently deleted.

## Docker / Dockploy deployment

The project ships with a `Dockerfile` and an `entrypoint.sh` script. The secrets
(`credentials.json`, `token.json`) are **never baked into the image** — they are
recreated at startup from base64 environment variables.

1. Build and run locally:

   ```bash
   docker compose up --build
   ```

2. On a hosting platform (e.g. Dockploy), set these environment variables:

   | Variable             | Value                        |
   | -------------------- | ---------------------------- |
   | `DISCORD_TOKEN`      | your bot token               |
   | `DISCORD_CHANNEL_ID` | your channel ID              |
   | `CREDENTIALS_JSON`   | base64 of `credentials.json` |
   | `TOKEN_JSON`         | base64 of `token.json`       |

   The `entrypoint.sh` script decodes them into `credentials.json` and `token.json`
   before starting the bot.

## Attribution

This project was built by an AI coding agent using a **local** model
(Ornith Q4 262k) — everything ran locally, nothing was sent to the cloud.

## License

This work is licensed under the **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**.

You are free to share and adapt the material for **non-commercial purposes only**, provided you give appropriate credit and license any derivatives under the same terms. **Commercial use is not permitted.**

A short summary of the full license text is available at:
<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
