import { createSupabaseServerClient } from "@/lib/supabase";

interface AssignmentPayload {
  tab_id: string;
  token: string;
  assignments: {
    invitee_label: string;
    share_amount: number; // cents
    item_ids: string[];
  }[];
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
      invitee_label: a.invitee_label,
      share_amount: a.share_amount,
      item_ids: a.item_ids,
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

    return Response.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
