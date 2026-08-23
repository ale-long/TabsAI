# TabsAI

Tabs is an agentic, middleman platform that removes the social awkwardness and financial vulnerability of splitting group expenses. Upload a receipt to Discord, and Tabs handles the rest — extracting line items, splitting the bill, generating personal checkout links, and nudging people who haven't paid.

## How It Works

1. A user uploads a receipt image to a Discord channel.
2. The bot runs vision-based OCR (Groq) to extract line items, tax, tip, and totals.
3. A LangGraph state machine validates the extraction and prompts the user to resolve any math discrepancies.
4. The user chooses a split method via Discord buttons:
   - **Even split** — pick participants with a native user selector; each person gets a checkout link for their equal share.
   - **Itemized split** — the organizer opens a drag-and-drop tagger UI to assign specific items to each person, then per-invitee checkout links are generated.
5. Each participant receives a single-use, time-limited checkout link where they pay their share via Stripe.
6. If someone hasn't paid, the nudge engine sends AI-generated reminders to the Discord channel on an escalating tone schedule.

## Architecture

```
app/
├── discord-bot/     # Python — Discord gateway bot, receipt ingestion, LangGraph intent engine
├── worker/          # TypeScript — Cloudflare Worker handling Discord interactions via HTTP
├── checkout-ui/     # Next.js — checkout and itemized split tagger UI, Stripe integration
└── nudge/           # TypeScript — Cloudflare Worker cron job for AI-driven payment reminders
```

### Discord Bot (`app/discord-bot`)
Python bot using `discord.py` that listens for image uploads, provisions users in Supabase, streams receipt images to Supabase Storage, and kicks off the OCR + split workflow. Includes a LangGraph state machine (`intent_engine.py`) with validation, human-in-the-loop fix prompts, split-type resolution, and interactive Discord UI views (buttons, user selects).

### Interactions Worker (`app/worker`)
TypeScript Cloudflare Worker that handles Discord interactions over HTTP (slash commands, button clicks, user selects) with Ed25519 signature verification. Mirrors the bot's split logic for the serverless path.

### Checkout UI (`app/checkout-ui`)
Next.js app deployed on Cloudflare Pages. Provides:
- `/split/[tab_id]` — drag-and-drop item tagger for itemized splits
- `/checkout/[tab_id]` — per-invitee payment page with Stripe Elements
- `/api/create-payment-intent` — Stripe payment intent creation
- `/api/stripe-webhook` — webhook handler for payment confirmation
- `/api/confirm-split` — finalizes itemized split assignments

All routes are gated by single-use, 15-minute auth tokens.

### Nudge Engine (`app/nudge`)
Cloudflare Worker cron trigger (every 6 hours) that queries unpaid assignments, generates tone-escalating reminders via Groq, and dispatches them to Discord channels. Tracks nudge count and cooldown per assignment.

## Tech Stack

- **AI/LLM**: Groq (vision OCR + nudge generation), LangGraph (state machine orchestration)
- **Backend**: Supabase (Postgres DB + Storage + Auth tokens), Cloudflare Workers
- **Frontend**: Next.js, Tailwind CSS, Stripe Elements
- **Payments**: Stripe
- **Messaging**: Discord (gateway bot + HTTP interactions API)

## Key Data Model

| Table | Purpose |
|-------|---------|
| `users` | Discord users provisioned on first interaction |
| `tabs` | One row per receipt upload — tracks status, split type, totals |
| `receipt_items` | Line items extracted from the receipt (prices in cents) |
| `tab_assignments` | Per-invitee share amounts, payment status, nudge tracking |
| `auth_tokens` | Single-use, time-limited tokens for checkout links |
