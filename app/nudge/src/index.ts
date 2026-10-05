import { createClient } from "@supabase/supabase-js";

interface Env {
  DISCORD_BOT_TOKEN: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  GROQ_API_KEY: string;
}

const DISCORD_API = "https://discord.com/api/v10";
const COOLDOWN_HOURS = 48;

const TONE_ESCALATION = [
  {
    label: "Soft",
    maxNudges: 1,
    directive:
      "Be warm and friendly. Gently remind them they have an unpaid tab. Keep it light — like a friend texting a friend.",
  },
  {
    label: "Casual",
    maxNudges: 3,
    directive:
      "Be casual but clear. They've been reminded before. Mention the amount and that others are waiting. No passive aggression — just straightforward.",
  },
  {
    label: "Direct",
    maxNudges: Infinity,
    directive:
      "Be direct and firm. This is a final-style reminder. State the amount owed, that this is overdue, and that the tab creator is waiting. Keep it short and serious.",
  },
] as const;

interface Assignment {
  id: string;
  tab_id: string;
  discord_user_id: string;
  invitee_label: string;
  share_amount: number;
  nudge_count: number;
  last_nudged_at: string | null;
  tabs: {
    discord_channel_id: string;
    creator_id: string;
    users: { username: string } | null;
  };
}

function getTone(nudgeCount: number): (typeof TONE_ESCALATION)[number] {
  for (const tone of TONE_ESCALATION) {
    if (nudgeCount < tone.maxNudges) return tone;
  }
  return TONE_ESCALATION[TONE_ESCALATION.length - 1];
}

async function generateNudgeMessage(
  groqApiKey: string,
  inviteeLabel: string,
  amountDollars: string,
  creatorName: string,
  tone: (typeof TONE_ESCALATION)[number],
): Promise<string | null> {
  const systemPrompt = `You are a payment reminder bot for a group bill-splitting app called TabsAI.
Write a single short Discord message (1-3 sentences, under 280 characters) reminding someone to pay their share.

Rules:
- Address them by name
- Mention the dollar amount
- Mention who created the tab (the person they owe)
- Do NOT use emojis
- Do NOT include links, instructions, or how to pay
- Do NOT use hashtags or @mentions
- Tone: ${tone.directive}`;

  const userPrompt = `Name: ${inviteeLabel}\nAmount owed: $${amountDollars}\nTab creator: ${creatorName}`;

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    console.error(`Groq API error: ${res.status} ${res.statusText}`);
    const body = await res.text();
    console.error("Groq response body:", body);
    return null;
  }

  const data: any = await res.json();
  let content = data.choices?.[0]?.message?.content?.trim();
  console.log("Raw LLM response:", content);
  if (!content) {
    console.error("Groq returned empty content:", JSON.stringify(data));
    return null;
  }
  content = content.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (!content) {
    console.error("LLM response was only thinking tags, no message produced.");
    return null;
  }
  return content;
}

async function sendChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
): Promise<void> {
  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
}

async function processNudges(env: Env, force = false): Promise<void> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

  let query = supabase
    .from("tab_assignments")
    .select(
      `
      id,
      tab_id,
      discord_user_id,
      invitee_label,
      share_amount,
      nudge_count,
      last_nudged_at,
      tabs!inner (
        discord_channel_id,
        creator_id,
        users!tabs_creator_id_fkey ( username )
      )
    `,
    );

  if (!force) {
    const cutoff = new Date(
      Date.now() - COOLDOWN_HOURS * 60 * 60 * 1000,
    ).toISOString();
    query = query
      .eq("paid", false)
      .or(`last_nudged_at.is.null,last_nudged_at.lt.${cutoff}`)
      .in("tabs.status", ["assigned", "active"]);
  } else {
    console.log("Force mode — skipping cooldown and paid filters.");
    query = query.in("tabs.status", ["assigned", "active"]);
  }

  const { data: assignments, error } = await query;

  if (error) {
    console.error("Failed to fetch eligible assignments:", error.message);
    return;
  }

  if (!assignments || assignments.length === 0) {
    console.log("No eligible assignments to nudge.");
    return;
  }

  console.log(`Found ${assignments.length} assignment(s) to nudge.`);

  for (const raw of assignments) {
    const assignment = raw as unknown as Assignment;
    const tabInfo = assignment.tabs;
    const channelId = tabInfo.discord_channel_id;
    const creatorName = tabInfo.users?.username ?? "the tab creator";
    const amountDollars = (assignment.share_amount / 100).toFixed(2);
    const currentNudgeCount = assignment.nudge_count ?? 0;
    const tone = getTone(currentNudgeCount);

    console.log(
      `[${assignment.tab_id}] Nudging ${assignment.invitee_label} — $${amountDollars} — tone: ${tone.label} (#${currentNudgeCount + 1})`,
    );

    try {
      const message = await generateNudgeMessage(
        env.GROQ_API_KEY,
        assignment.invitee_label,
        amountDollars,
        creatorName,
        tone,
      );

      const discordPing = `<@${assignment.discord_user_id}>`;
      const body = message
        ? `${discordPing} 💬 **Payment Reminder**\n${message}`
        : `${discordPing} 💬 **Payment Reminder**\nHey ${assignment.invitee_label}, you still owe **$${amountDollars}** for the tab created by ${creatorName}.`;

      await sendChannelMessage(env.DISCORD_BOT_TOKEN, channelId, body);

      await supabase
        .from("tab_assignments")
        .update({
          last_nudged_at: new Date().toISOString(),
          nudge_count: currentNudgeCount + 1,
        })
        .eq("id", assignment.id);

      console.log(`[${assignment.tab_id}] Nudge sent to ${assignment.invitee_label}.`);
    } catch (err: any) {
      console.error(
        `[${assignment.tab_id}] Failed to nudge ${assignment.invitee_label}:`,
        err.message,
      );
    }
  }
}

export default {
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(processNudges(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/force") {
      ctx.waitUntil(processNudges(env, true));
      return new Response("Force nudge triggered.", { status: 200 });
    }
    return new Response("Nudge worker is cron-only. Use /force to trigger manually.", { status: 200 });
  },
};
