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

All sensitive values are stored as Cloudflare Worker secrets. Run each command and paste the value when prompted:

```bash
wrangler secret put DISCORD_PUBLIC_KEY
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put DISCORD_APPLICATION_ID
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put GROQ_API_KEY
wrangler secret put APP_BASE_URL
```

| Secret | Where to find it |
|---|---|
| `DISCORD_PUBLIC_KEY` | Discord Developer Portal → your app → General Information → Public Key |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → your app → Bot → Token |
| `DISCORD_APPLICATION_ID` | Discord Developer Portal → your app → General Information → Application ID |
| `SUPABASE_URL` | Supabase project → Settings → API → Project URL |
| `SUPABASE_KEY` | Supabase project → Settings → API → `service_role` key |
| `GROQ_API_KEY` | [Groq Console](https://console.groq.com/) → API Keys |
| `APP_BASE_URL` | The deployed URL of the Next.js checkout UI (no trailing slash) |

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

This starts a local dev server via `wrangler dev`. To expose it to Discord for testing, use a tunnel such as [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) or ngrok, and set the tunnel URL as the Interactions Endpoint.

## Required Bot Permissions

When generating an OAuth2 invite link, include these scopes and permissions:

- **Scopes:** `bot`, `applications.commands`
- **Bot Permissions:** `Send Messages`, `Attach Files`, `Use Slash Commands`
