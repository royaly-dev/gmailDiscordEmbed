# gmailDiscordEmbed

A small Discord bot that connects to one or **several** Gmail accounts, reads each
inbox, and posts an embed on Discord for every new mail.

Each embed shows the subject, sender, date and a preview of the message body, and
comes with two buttons: **Kept** (removes the embed) and **Removed** (removes the
embed and moves the mail to Gmail's trash).

## Features

- 🔒 **OAuth2** authentication with the Gmail API (no credentials stored in code).
- 🧑‍🤝‍🧑 **Multiple Gmail accounts** — every account in `token.json` is monitored.
- 📺 **One Discord channel per account** — each account posts to its own dedicated channel.
- 📥 Monitors the **inbox**, only for mails **addressed to you** and **not yet read**.
- 🔁 Re-checks every **30 minutes** and skips mails it has already sent (per account).
- 💬 Posts an embed per new mail with a **@everyone** ping.
- 🗑️ Interactive buttons: **Kept** / **Removed** (trash the mail).
- 💾 Remembers which mails were already sent (`seen.json`, per account) so a restart
  doesn't re-send everything.

## How it works

```
Gmail A  ──(Gmail API, OAuth2)──┐
Gmail B  ──(Gmail API, OAuth2)──┴──▶  bot (loop every 30 min)  ──▶  channel A  (for A)
  ...                                                          ──▶  channel B  (for B)
```

On every cycle the bot loops over **every account** in `token.json` and, for each:

1. Fetches the unread inbox mails addressed to that account.
2. Compares their IDs with the ones it has already seen (per account).
3. For each **new** mail, posts an embed to that account's **dedicated Discord channel**.

### `token.json` structure (multi-account)

`token.json` is now an **array** of accounts. Each entry keeps its OAuth fields and adds
`email` (the Gmail address) and `discordChannelId` (the channel to post to for this account):

```json
[
  {
    "access_token": "…",
    "refresh_token": "…",
    "scope": "https://www.googleapis.com/auth/gmail.modify",
    "token_type": "Bearer",
    "expiry_date": 1791288586469,
    "email": "accountA@gmail.com",
    "discordChannelId": "123456789012345678"
  },
  {
    "access_token": "…",
    "refresh_token": "…",
    "email": "accountB@gmail.com",
    "discordChannelId": "987654321098765432"
  }
]
```

To **add a second account**, either:

- add a new entry to this array (with its OAuth tokens from the flow below), or
- leave it without tokens and set `email` + `discordChannelId`; the bot will prompt you
  to authorize that account on next run.

## Version / Changelog

### v1.1 — Multi-account (current)

- 🧑‍🤝‍🧑 Support for **several Gmail accounts** : `token.json` is now an **array** of accounts, iterated over on every cycle.
- 📺 **One dedicated Discord channel per account** : each account posts to its own channel (`discordChannelId`), no more single channel.
- 💾 `seen.json` **per-account** (`{ "email": [ids] }`) : mail IDs are no longer shared between accounts.
- 🔑 **OAuth2 is launched per account** : accounts can be authorized one at a time.
- 🗑️ The **Keep** / **Remove** buttons now target the **right account** (via its stored OAuth client).

### v1 — (initial version)

- 🔒 **OAuth2** authentication with the Gmail API (no secrets in code).
- 📥 **Inbox** monitoring, for **unread** mails **addressed to the account**.
- 🔁 Re-check every **30 minutes**, skipping already-sent mails.
- 💬 One embed per new mail with an **@everyone** ping.
- 🗑️ Interactive **Keep** / **Remove** buttons (Gmail trash).
- 💾 Remembers already-sent mails (`seen.json`) to survive a restart.

### v1.1 — What changed compared to v1

| Item | v1 (old) | v1.1 (new) |
| --- | --- | --- |
| `token.json` | **a single** OAuth token (object) | **array** of accounts, each with its tokens + `email` + `discordChannelId` |
| Monitored Gmail accounts | **a single** account | **as many as you like** (loop over the whole array) |
| `seen.json` | already-seen IDs (flat) | already-seen IDs **per account** |
| OAuth authorization flow | once | **per account**, on demand |

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
5. Authorize Gmail accounts. The bot does this automatically on first run: for each
   account **without** a token yet, it prints an authorization URL, you open it, paste
   the redirect URL (or code) back, and it saves the token into that account's entry in
   `token.json`.

> To authorize an extra account later, add its entry (email + `discordChannelId`, no
> tokens yet) to `token.json` and run the bot — it will prompt you for that account.

> The bot requests the **`gmail.modify`** scope because it needs to be able to move
> mails to the trash. It reads the inbox and writes the trash only.

## Discord setup

Create a `.env` file in the project root (or set these as environment variables):

```env
DISCORD_TOKEN=your_bot_token
```

- Get the bot token at <https://developers.discord.com/> (Application → Bot → Token).
  This token is **shared** between all monitored Gmail accounts.

> **Channel per account** — with the multi-account setup, the Discord channel is set
> individually for each account in `token.json` (field `discordChannelId`), not through
> Discord settings, right-clicking the channel, and copying the ID.

If an account has no `discordChannelId`, or its channel can't be reached, the bot simply
skips sending embeds for that account (with a warning).

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
   | `CREDENTIALS_JSON`   | base64 of `credentials.json` |
   | `TOKEN_JSON`         | base64 of `token.json` (array) |

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
