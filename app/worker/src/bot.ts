import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { verifyKey } from "discord-interactions";
import { IntentEngine } from "./intent-engine";

// ---------------------------------------------------------------------------
// Environment — set secrets via `wrangler secret put <NAME>`
// ---------------------------------------------------------------------------

export interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  GROQ_API_KEY: string;
  APP_BASE_URL: string;
}

// ---------------------------------------------------------------------------
// Discord constants
// ---------------------------------------------------------------------------

const DISCORD_API = "https://discord.com/api/v10";

const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  UPDATE_MESSAGE: 7,
} as const;

const ComponentType = { ACTION_ROW: 1, BUTTON: 2, USER_SELECT: 5 } as const;
const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 } as const;

const PREFERRED_VISION_MODELS = ["qwen/qwen3.6-27b"];

// ---------------------------------------------------------------------------
// Ed25519 signature verification via discord-interactions
// ---------------------------------------------------------------------------

async function verifySignature(
  request: Request,
  publicKey: string,
): Promise<{ valid: boolean; body: string }> {
  const signature = request.headers.get("X-Signature-Ed25519") ?? "";
  const timestamp = request.headers.get("X-Signature-Timestamp") ?? "";
  const body = await request.text();

  const valid = await verifyKey(body, signature, timestamp, publicKey);

  return { valid, body };
}

// ---------------------------------------------------------------------------
// Discord REST helpers
// ---------------------------------------------------------------------------

async function sendChannelMessage(
  botToken: string,
  channelId: string,
  content: string,
  components?: unknown[],
): Promise<void> {
  const payload: Record<string, unknown> = { content };
  if (components) payload.components = components;

  await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

async function editOriginalResponse(
  appId: string,
  interactionToken: string,
  content: string,
  components?: unknown[],
): Promise<void> {
  await fetch(
    `${DISCORD_API}/webhooks/${appId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, components: components ?? [] }),
    },
  );
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Component builders — construct the JSON Discord expects for interactive UI
// (replaces discord.py View subclasses: SplitTypeView, EvenSplitSelectView,
//  ReceiptFixView)
// ---------------------------------------------------------------------------

function buildUserSelect(tabId: string) {
  return [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.USER_SELECT,
          custom_id: `select_even_split:${tabId}`,
          placeholder: "Select everyone splitting this bill…",
          min_values: 1,
          max_values: 25,
        },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------
// Auth token creation — from bot.py create_auth_token()
// ---------------------------------------------------------------------------

async function createAuthToken(
  supabase: SupabaseClient,
  tabId: string,
  discordUserId: string,
): Promise<string> {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const token = btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  await supabase.from("auth_tokens").insert({
    token,
    discord_user_id: discordUserId,
    tab_id: tabId,
    expires_at: expiresAt,
    is_used: false,
  });

  return token;
}

// ---------------------------------------------------------------------------
// User provisioning — from bot.py provision_user()
// ---------------------------------------------------------------------------

async function provisionUser(
  supabase: SupabaseClient,
  discordUserId: string,
  username: string,
): Promise<{ userId: string; username: string }> {
  const { data: user, error } = await supabase
    .from("users")
    .upsert(
      { discord_user_id: discordUserId, username },
      { onConflict: "discord_user_id" },
    )
    .select("id, username")
    .single();

  if (error || !user) {
    throw new Error(`Failed to provision user ${discordUserId}: ${error?.message ?? "no data returned"}`);
  }

  return { userId: user.id, username: user.username };
}

// ---------------------------------------------------------------------------
// Receipt processing — from bot.py process_receipt_vision()
//
// In the gateway bot this ran as an asyncio.create_task after the image was
// detected in on_message.  Here it runs inside ctx.waitUntil() after the
// /receipt slash command is deferred.
// ---------------------------------------------------------------------------

async function processReceiptVision(
  env: Env,
  supabase: SupabaseClient,
  tabId: string,
  imageUrl: string,
  channelId: string,
  interactionToken: string,
): Promise<void> {
  try {
    const systemPrompt = `You are a highly precise financial OCR engine.
Extract the line items, subtotal, tax, tip, and total from the provided receipt image.
Ignore non-financial text (like restaurant addresses or 'thank you' messages).

You MUST respond ONLY with a valid JSON object matching this exact schema:
{
  "items": [
    {"item_name": "string", "unit_price": float, "quantity": integer}
  ],
  "subtotal": float,
  "tax": float,
  "tip": float,
  "total": float
}
Do not include markdown blocks, explanations, or any text outside the JSON object.`;

    console.log(`[${tabId}] Sending to Groq Vision...`);
    const groqRes = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: PREFERRED_VISION_MODELS[0],
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
      },
    );

    const groqData: any = await groqRes.json();
    const rawJson = groqData.choices[0].message.content;
    const receiptData = JSON.parse(rawJson);
    console.log(
      `[${tabId}] Extraction successful, total: $${receiptData.total}`,
    );

    // Data transformation: dollars → integer cents
    const totalCents = Math.round((receiptData.total ?? 0) * 100);

    const dbItems: Record<string, unknown>[] = [];
    for (const item of receiptData.items ?? []) {
      dbItems.push({
        tab_id: tabId,
        item_name: (item.item_name as string).slice(0, 255),
        unit_price: Math.round(item.unit_price * 100),
        quantity: item.quantity ?? 1,
      });
    }
    if ((receiptData.tax ?? 0) > 0) {
      dbItems.push({
        tab_id: tabId,
        item_name: "Tax",
        unit_price: Math.round(receiptData.tax * 100),
        quantity: 1,
      });
    }
    if ((receiptData.tip ?? 0) > 0) {
      dbItems.push({
        tab_id: tabId,
        item_name: "Tip",
        unit_price: Math.round(receiptData.tip * 100),
        quantity: 1,
      });
    }

    // Database transactions
    if (dbItems.length > 0) {
      await supabase.from("receipt_items").insert(dbItems);
    }
    await supabase
      .from("tabs")
      .update({ total_amount: totalCents })
      .eq("id", tabId);

    // Notify via interaction followup
    const itemCount = (receiptData.items ?? []).length;
    const formattedTotal = `$${(receiptData.total ?? 0).toFixed(2)}`;
    await editOriginalResponse(
      env.DISCORD_APPLICATION_ID,
      interactionToken,
      `✅ Extracted **${itemCount} items** for a total of **${formattedTotal}**! (Tab ID: \`${tabId}\`)\n*Next up: Resolving split parameters...*`,
    );

    // Run the intent engine (replaces shared.app.ainvoke)
    const engine = new IntentEngine(supabase, env.DISCORD_BOT_TOKEN);
    await engine.run(tabId, channelId);
  } catch (e: any) {
    console.error(`[${tabId}] Error in Vision Node:`, e);
    await editOriginalResponse(
      env.DISCORD_APPLICATION_ID,
      interactionToken,
      `❌ Failed to parse the receipt. Please try taking a clearer photo. Error: \`${e.message}\``,
    );
  }
}

// ---------------------------------------------------------------------------
// Interaction handlers
// ---------------------------------------------------------------------------

// --- /receipt slash command (replaces on_message image detection) ---

async function handleUploadReceipt(
  interaction: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const discordUserId: string =
    interaction.member?.user?.id ?? interaction.user?.id;
  const username: string =
    interaction.member?.user?.username ?? interaction.user?.username;
  const channelId: string = interaction.channel_id;
  const guildId: string | null = interaction.guild_id ?? null;

  const options: any[] = interaction.data.options ?? [];
  const attachmentOption = options.find((o: any) => o.name === "receipt");
  if (!attachmentOption) {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please attach a receipt image.", flags: 64 },
    });
  }

  const attachmentId = attachmentOption.value;
  const attachment =
    interaction.data.resolved?.attachments?.[attachmentId];
  if (!attachment?.content_type?.startsWith("image/")) {
    return jsonResponse({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "❌ Please attach a valid image file.", flags: 64 },
    });
  }

  // Defer — OCR takes time
  const deferResponse = jsonResponse({
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  });

  ctx.waitUntil(
    (async () => {
      try {
        // A. User provisioning (from bot.py on_message)
        const { userId: userUuid } = await provisionUser(
          supabase,
          discordUserId,
          username,
        );

        // B. File ingestion — fetch from Discord CDN, upload to Supabase Storage
        const imageRes = await fetch(attachment.url);
        const imageBytes = await imageRes.arrayBuffer();
        const storagePath = `${discordUserId}/${Date.now()}_${attachment.filename}`;

        await supabase.storage.from("receipts").upload(storagePath, imageBytes, {
          contentType: attachment.content_type,
        });

        const {
          data: { publicUrl },
        } = supabase.storage.from("receipts").getPublicUrl(storagePath);

        // C. State creation — insert tab record
        const { data: tabRes } = await supabase
          .from("tabs")
          .insert({
            creator_id: userUuid,
            discord_channel_id: channelId,
            discord_guild_id: guildId,
            receipt_storage_url: publicUrl,
            status: "pending_context",
          })
          .select("id")
          .single();

        const tabId = tabRes!.id;

        // Acknowledge upload
        await editOriginalResponse(
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          `🧾 Receipt intercepted and uploaded to the DB! Initiating extraction sequence... (Tab ID: \`${tabId}\`)`,
        );

        // D. OCR + intent engine
        await processReceiptVision(
          env,
          supabase,
          tabId,
          publicUrl,
          channelId,
          interaction.token,
        );
      } catch (e: any) {
        console.error("Upload receipt error:", e);
        await editOriginalResponse(
          env.DISCORD_APPLICATION_ID,
          interaction.token,
          `❌ Something went wrong: \`${e.message}\``,
        );
      }
    })(),
  );

  return deferResponse;
}

// --- Button clicks (replaces SplitTypeView / ReceiptFixView handlers) ---

async function handleButtonClick(
  interaction: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const customId: string = interaction.data.custom_id;
  const colonIdx = customId.indexOf(":");
  const action = customId.slice(0, colonIdx);
  const tabId = customId.slice(colonIdx + 1);

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const channelId: string = interaction.channel_id;
  const appBaseUrl = (env.APP_BASE_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );

  switch (action) {
    // --- SplitTypeView.even_button ---
    case "btn_even": {
      const response = jsonResponse({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: "✅ **Even** split selected! Processing...",
          components: [],
        },
      });

      ctx.waitUntil(
        (async () => {
          await supabase
            .from("tabs")
            .update({ split_type: "even", status: "active" })
            .eq("id", tabId);

          const engine = new IntentEngine(supabase, env.DISCORD_BOT_TOKEN);
          await engine.resumeWithSplit(tabId);

          await sendChannelMessage(
            env.DISCORD_BOT_TOKEN,
            channelId,
            "👥 **Who's splitting this bill evenly?**\n*Select everyone included (add yourself too if you're chipping in).*",
            buildUserSelect(tabId),
          );
        })(),
      );

      return response;
    }

    // --- SplitTypeView.itemize_button ---
    case "btn_itemize": {
      const response = jsonResponse({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: "✅ **Itemized** split selected! Processing...",
          components: [],
        },
      });

      ctx.waitUntil(
        (async () => {
          await supabase
            .from("tabs")
            .update({ split_type: "itemized", status: "active" })
            .eq("id", tabId);

          const engine = new IntentEngine(supabase, env.DISCORD_BOT_TOKEN);
          await engine.resumeWithSplit(tabId);

          const discordUserId: string =
            interaction.member?.user?.id ?? interaction.user?.id;
          const token = await createAuthToken(supabase, tabId, discordUserId);
          const url = `${appBaseUrl}/split/${tabId}?token=${token}`;

          await sendChannelMessage(
            env.DISCORD_BOT_TOKEN,
            channelId,
            `🧾 **Itemize your split here:** ${url}\n*Tag each item to a person, then share the generated links. Valid for 15 minutes.*`,
          );
        })(),
      );

      return response;
    }

    // --- ReceiptFixView.approve_button ---
    case "btn_approve_math": {
      const response = jsonResponse({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content:
            "✅ **Math warning overridden.** Proceeding with the extracted totals...",
          components: [],
        },
      });

      ctx.waitUntil(
        (async () => {
          const engine = new IntentEngine(supabase, env.DISCORD_BOT_TOKEN);
          await engine.resumeFromFix(tabId, channelId);
        })(),
      );

      return response;
    }

    // --- ReceiptFixView.cancel_button ---
    case "btn_cancel_tab": {
      ctx.waitUntil(
        (async () => {
          await supabase
            .from("tabs")
            .update({ status: "canceled" })
            .eq("id", tabId);
          console.log(`[${tabId}] Tab cancelled by user.`);
        })(),
      );

      return jsonResponse({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content:
            "🚫 **Tab cancelled.** Please try taking a clearer photo of the receipt and upload again.",
          components: [],
        },
      });
    }

    default:
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "❌ Unknown action.", flags: 64 },
      });
  }
}

// --- User select (replaces EvenSplitSelectView.select_users) ---

async function handleUserSelect(
  interaction: any,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const customId: string = interaction.data.custom_id;
  const tabId = customId.split(":")[1];
  const selectedUserIds: string[] = interaction.data.values;
  const resolvedUsers: Record<string, any> =
    interaction.data.resolved?.users ?? {};
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const channelId: string = interaction.channel_id;
  const appBaseUrl = (env.APP_BASE_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const n = selectedUserIds.length;

  const response = jsonResponse({
    type: InteractionResponseType.UPDATE_MESSAGE,
    data: {
      content: `✅ Splitting evenly between **${n}** people. Generating links…`,
      components: [],
    },
  });

  ctx.waitUntil(
    (async () => {
      // Look up receipt total (stored in cents)
      const { data: tabData } = await supabase
        .from("tabs")
        .select("total_amount")
        .eq("id", tabId)
        .single();

      const totalCents: number = tabData?.total_amount ?? 0;

      // Even division with remainder handling — first `remainder` people
      // absorb the leftover cents so shares sum exactly to the total.
      const baseShare = Math.floor(totalCents / n);
      const remainder = totalCents % n;

      // Rebuild assignments from scratch so re-selecting overwrites cleanly.
      await supabase.from("tab_assignments").delete().eq("tab_id", tabId);

      const assignmentRows: Record<string, unknown>[] = [];
      const linkLines: string[] = [];

      for (let idx = 0; idx < selectedUserIds.length; idx++) {
        const userId = selectedUserIds[idx];
        const user = resolvedUsers[userId];
        const shareCents = baseShare + (idx < remainder ? 1 : 0);

        const { username } = await provisionUser(
          supabase,
          userId,
          user?.username ?? `user_${userId}`,
        );
        const token = await createAuthToken(supabase, tabId, userId);

        assignmentRows.push({
          tab_id: tabId,
          discord_user_id: userId,
          invitee_label: username,
          share_amount: shareCents,
          item_ids: [],
          paid: false,
        });

        const url = `${appBaseUrl}/checkout/${tabId}?token=${token}&user=${userId}`;
        linkLines.push(
          `• <@${userId}> — **$${(shareCents / 100).toFixed(2)}**\n${url}`,
        );
      }

      await supabase.from("tab_assignments").insert(assignmentRows);
      await supabase
        .from("tabs")
        .update({ status: "assigned" })
        .eq("id", tabId);

      await sendChannelMessage(
        env.DISCORD_BOT_TOKEN,
        channelId,
        "💳 **Even split — personal checkout links:**\n" +
          linkLines.join("\n") +
          "\n\n*Each link is single-use and valid for 15 minutes.*",
      );
    })(),
  );

  return response;
}

// ---------------------------------------------------------------------------
// Main worker entry point — replaces the discord.py gateway client
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const { valid, body } = await verifySignature(
      request,
      env.DISCORD_PUBLIC_KEY,
    );
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    const interaction = JSON.parse(body);

    // PING — required for Discord webhook URL verification
    if (interaction.type === InteractionType.PING) {
      return jsonResponse({ type: InteractionResponseType.PONG });
    }

    // Slash commands (replaces @client.event on_message routing)
    if (interaction.type === InteractionType.APPLICATION_COMMAND) {
      if (interaction.data.name === "receipt") {
        return handleUploadReceipt(interaction, env, ctx);
      }
      return jsonResponse({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "❌ Unknown command.", flags: 64 },
      });
    }

    // Message components — buttons and selects
    if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
      const customId: string = interaction.data.custom_id;

      if (customId.startsWith("select_even_split:")) {
        return handleUserSelect(interaction, env, ctx);
      }
      if (customId.startsWith("btn_")) {
        return handleButtonClick(interaction, env, ctx);
      }
    }

    return new Response("Unknown interaction type", { status: 400 });
  },
};
