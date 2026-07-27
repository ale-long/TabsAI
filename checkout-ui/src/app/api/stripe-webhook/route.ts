import Stripe from "stripe";
import { createSupabaseServerClient } from "@/lib/supabase";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return Response.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "payment_intent.succeeded") {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const { tab_id, invitee } = paymentIntent.metadata;

    if (tab_id && invitee) {
      const supabase = createSupabaseServerClient();

      await supabase
        .from("tab_assignments")
        .update({ paid: true, paid_at: new Date().toISOString() })
        .eq("tab_id", tab_id)
        .eq("invitee_label", invitee);

      const { data: assignments } = await supabase
        .from("tab_assignments")
        .select("paid")
        .eq("tab_id", tab_id);

      const allPaid =
        assignments && assignments.length > 0 && assignments.every((a) => a.paid);

      if (allPaid) {
        await supabase.from("tabs").update({ status: "closed" }).eq("id", tab_id);
      }
    }
  }

  return Response.json({ received: true });
}
