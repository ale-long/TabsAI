# TabsAI Discord Bot — Cloudflare Worker

Serverless webhook-based Discord bot running on Cloudflare Workers. Replaces the gateway-based Python bot with a stateless HTTP handler.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A [Cloudflare](https://dash.cloudflare.com/) account
- Wrangler CLI (`npm install -g wrangler` or use the local dev dependency)
- A Discord application with a bot user ([Discord Developer Portal](https://discord.com/developers/applications))

## Install

```bash
cd worker
npm install
```

## Configure Secrets

### Environment Variables

`APP_BASE_URL` is set as a var in `wrangler.toml` under `[vars]` and points to the deployed checkout UI (e.g. `https://checkout-ui.tabsai.workers.dev`). Update it there if the checkout UI URL changes.

### Secrets

All sensitive values are stored as Cloudflare Worker secrets. Run each command and paste the value when prompted:

```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put GROQ_API_KEY
```

| Secret | Where to find it |
|---|---|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → your app → General Information → Public Key |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → your app → Bot → Token |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → your app → General Information → Application ID |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_KEY` | Supabase project → Settings → API → `service_role` key |
| `GROQ_API_KEY` | [Groq Console](https://console.groq.com/) → API Keys |

## Register the Slash Command

The `/receipt` command must be registered once with Discord:

```bash
DISCORD_BOT_TOKEN=<your-token> DISCORD_APPLICATION_ID=<your-app-id> npm run register
```

This uses the bulk-overwrite endpoint, so it's safe to re-run — it won't create duplicates.

## Deploy

```bash
npm run deploy
```

Wrangler will print the worker URL (e.g. `https://tabs-ai-discord-bot.<your-subdomain>.workers.dev`).

## Set the Interactions Endpoint

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → your app → General Information.
2. Paste the worker URL into **Interactions Endpoint URL**.
3. Discord will send a PING to verify the signature — it should succeed immediately.

## Local Development

```bash
npm run dev
```

This starts a local dev server via `wrangler dev`. To expose it to Discord for testing, open a second terminal and start a Cloudflare Tunnel:

```bash
npx cloudflared tunnel --url http://localhost:8787
```

Cloudflared will print a public URL (e.g. `https://<random>.trycloudflare.com`). Copy that URL and set it as the **Interactions Endpoint URL** in the [Discord Developer Portal](https://discord.com/developers/applications) → your app → General Information. The tunnel stays active as long as the command is running.

## Required Bot Permissions

When generating an OAuth2 invite link, include these scopes and permissions:

- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:** `Send Messages`, `Attach Files`, `Use Slash Commands`

### Privileged Intents

The **Server Members Intent** must be enabled in the Discord Developer Portal (Bot → Privileged Gateway Intents). This is required for the checkout UI to fetch guild members for the itemized split drag-and-drop interface.

## How It Works

1. **`/receipt` command** — User uploads a receipt image. The bot stores it in Supabase Storage, sends it to Groq Vision for OCR, and extracts line items, tax, tip, and total. The extraction result is posted to Discord with the receipt image embedded.
2. **Split type selection** — The bot presents Even / Itemized buttons. 
   - **Even:** Bot shows a user select menu, divides the total, and sends each person a personal checkout link with `<@user>` pings.
   - **Itemized:** Bot generates a link to the checkout UI's split tagger page where the organizer assigns items to guild members via drag-and-drop. On confirm, the checkout UI sends Discord messages with per-person checkout links and `<@user>` pings.
3. **Payment** — Each person opens their checkout link, pays via Stripe (card, Apple Pay, or Google Pay), and the Stripe webhook marks their assignment as paid. When all assignments are paid, the tab is closed.
