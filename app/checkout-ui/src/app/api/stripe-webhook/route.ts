import Stripe from "stripe";
import { createSupabaseServerClient } from "@/lib/supabase";

const DISCORD_API = "https://discord.com/api/v10";

async function sendDiscordMessage(
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

export async function POST(request: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] signature verification failed:", err);
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  console.log("[stripe-webhook] received event:", event.type);

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const { tab_id, invitee } = paymentIntent.metadata;

    console.log("[stripe-webhook] payment_intent.succeeded metadata:", { tab_id, invitee });

    if (tab_id && invitee) {
      const supabase = createSupabaseServerClient();

      const { data: updated, error: updateError } = await supabase
        .from("tab_assignments")
        .update({ paid: true, paid_at: new Date().toISOString() })
        .eq("tab_id", tab_id)
        .eq("invitee_label", invitee)
        .select();

      if (updateError) {
        console.error("[stripe-webhook] failed to mark assignment paid:", updateError);
      } else {
        console.log("[stripe-webhook] rows updated:", updated?.length ?? 0);
      }

      const { data: assignments, error: fetchError } = await supabase
        .from("tab_assignments")
        .select("paid, invitee_label, discord_user_id")
        .eq("tab_id", tab_id);

      if (fetchError) {
        console.error("[stripe-webhook] failed to fetch assignments:", fetchError);
      }

      const allPaid =
        assignments && assignments.length > 0 && assignments.every((a) => a.paid);

      if (allPaid) {
        const { error: closeError } = await supabase
          .from("tabs")
          .update({ status: "closed" })
          .eq("id", tab_id);
        if (closeError) {
          console.error("[stripe-webhook] failed to close tab:", closeError);
        }
      }

      // Send Discord notification
      const botToken = process.env.DISCORD_BOT_TOKEN;
      if (botToken) {
        const { data: tab } = await supabase
          .from("tabs")
          .select("discord_channel_id")
          .eq("id", tab_id)
          .single();

        if (tab?.discord_channel_id) {
          const amount = `$${(paymentIntent.amount / 100).toFixed(2)}`;

          // Find the discord user ID for this invitee
          const assignment = assignments?.find((a) => a.invitee_label === invitee);
          const mention = assignment?.discord_user_id
            ? `<@${assignment.discord_user_id}>`
            : `**${invitee}**`;

          await sendDiscordMessage(
            botToken,
            tab.discord_channel_id,
            `✅ ${mention} has paid their share of **${amount}**!`,
          );

          if (allPaid) {
            await sendDiscordMessage(
              botToken,
              tab.discord_channel_id,
              "🎉 **All shares have been paid! This tab is now closed.**",
            );
          }
        }
      }
    } else {
      console.warn("[stripe-webhook] missing tab_id or invitee in metadata");
    }
  }

  return Response.json({ received: true });
}
