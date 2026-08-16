import { createSupabaseServerClient } from "@/lib/supabase";

interface AssignmentPayload {
  tab_id: string;
  token: string;
  assignments: {
    discord_user_id: string;
    invitee_label: string;
    share_amount: number; // cents
    item_ids: string[];
  }[];
}

const DISCORD_API = "https://discord.com/api/v10";

async function createAuthToken(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  tabId: string,
  discordUserId: string,
): Promise<string> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = btoa(String.fromCharCode(...bytes))
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

export async function POST(request: Request) {
  try {
    const body: AssignmentPayload = await request.json();
    const { tab_id, token, assignments } = body;

    if (!tab_id || !token || !assignments?.length) {
      return Response.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    const supabase = createSupabaseServerClient();

    // Validate the token
    const { data: authToken, error: tokenError } = await supabase
      .from("auth_tokens")
      .select("*")
      .eq("token", token)
      .eq("tab_id", tab_id)
      .single();

    if (tokenError || !authToken) {
      return Response.json({ error: "Invalid token" }, { status: 401 });
    }

    if (new Date(authToken.expires_at) < new Date()) {
      return Response.json({ error: "Token expired" }, { status: 401 });
    }

    // Clear any previous assignments for this tab
    await supabase
      .from("tab_assignments")
      .delete()
      .eq("tab_id", tab_id);

    // Insert new assignments
    const rows = assignments.map((a) => ({
      tab_id,
      discord_user_id: a.discord_user_id,
      invitee_label: a.invitee_label,
      share_amount: a.share_amount,
      item_ids: a.item_ids,
      paid: false,
    }));

    const { error: insertError } = await supabase
      .from("tab_assignments")
      .insert(rows);

    if (insertError) {
      return Response.json(
        { error: "Failed to save assignments" },
        { status: 500 }
      );
    }

    // Update the tab status to indicate assignments are confirmed
    await supabase
      .from("tabs")
      .update({ status: "assigned" })
      .eq("id", tab_id);

    // Send Discord notification with per-person checkout links
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (botToken) {
      const { data: tab } = await supabase
        .from("tabs")
        .select("discord_channel_id")
        .eq("id", tab_id)
        .single();

      if (tab?.discord_channel_id) {
        const requestUrl = new URL(request.url);
        const baseUrl = `${requestUrl.protocol}//${requestUrl.host}`;

        const linkLines: string[] = [];

        for (const a of assignments) {
          const inviteeToken = await createAuthToken(
            supabase,
            tab_id,
            a.discord_user_id,
          );
          const url = `${baseUrl}/split/${tab_id}?token=${inviteeToken}&invitee=${encodeURIComponent(a.invitee_label)}`;
          linkLines.push(
            `• <@${a.discord_user_id}> — **$${(a.share_amount / 100).toFixed(2)}**\n  ${url}`
          );
        }

        const message =
          "💳 **Itemized split confirmed — personal checkout links:**\n" +
          linkLines.join("\n") +
          "\n\n*Each link is single-use and valid for 15 minutes.*";

        await fetch(`${DISCORD_API}/channels/${tab.discord_channel_id}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${botToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: message }),
        });
      }
    }

    return Response.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
