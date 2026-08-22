# Psychological Nudge Engine

This module handles the automated, AI-driven reminder system for unpaid tabs. It runs entirely on a Cloudflare Worker Cron Trigger (`0 */6 * * *` — every 6 hours), eliminating the need for external background loops.

## Architecture

Instead of using a standard `fetch` HTTP handler, this module hooks into Cloudflare's `scheduled` event. When the cron triggers, the Worker:

1. Queries Supabase for unpaid `tab_assignments` joined to `tabs` (filtered to `active`/`assigned` status) where `last_nudged_at` is null or older than 48 hours.
2. Determines tone escalation based on `nudge_count`:
   - **Soft** (1st nudge) — warm, friendly, like a friend texting a friend.
   - **Casual** (2nd–3rd) — straightforward, mentions the amount and that others are waiting.
   - **Direct** (4th+) — firm and final, states the overdue amount clearly.
3. Drafts a constrained SMS-style reminder (under 280 chars, no emojis, no links) via Groq (`llama-3.3-70b-versatile`).
4. Dispatches the message to the tab's Discord channel via the REST API.
5. Updates the audit trail — sets `last_nudged_at` and increments `nudge_count` on the assignment row.

## Database Migration Required

Before deploying, ensure the Supabase schema includes the nudge tracking columns:

```sql
ALTER TABLE tab_assignments ADD COLUMN last_nudged_at TIMESTAMPTZ DEFAULT NULL;
ALTER TABLE tab_assignments ADD COLUMN nudge_count INT DEFAULT 0;
```

## Secrets

Set these via Wrangler before deploying:

```sh
wrangler secret put DISCORD_BOT_TOKEN
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_KEY
wrangler secret put GROQ_API_KEY
```

## Deploy

```sh
cd nudge
npm install
wrangler deploy
```

## Local Development

Test the cron handler locally with:

```sh
npm run dev
# Then trigger the scheduled event:
curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"
```
