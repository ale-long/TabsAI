import { createSupabaseServerClient } from "@/lib/supabase";
import type { Tab, ReceiptItem } from "@/lib/types";
import CheckoutClient from "../../split/[tab_id]/CheckoutClient";

interface PageProps {
  params: Promise<{ tab_id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function CheckoutPage({
  params,
  searchParams,
}: PageProps) {
  const { tab_id } = await params;
  const { token, user } = await searchParams;

  if (!token || typeof token !== "string") {
    return <ErrorScreen message="Missing or invalid authentication token." />;
  }

  if (!user || typeof user !== "string") {
    return <ErrorScreen message="Missing user identifier." />;
  }

  const supabase = createSupabaseServerClient();

  // Validate the auth token
  const { data: authToken, error: tokenError } = await supabase
    .from("auth_tokens")
    .select("*")
    .eq("token", token)
    .eq("tab_id", tab_id)
    .single();

  if (tokenError || !authToken) {
    return (
      <ErrorScreen message="Invalid or expired link. Please request a new one from Discord." />
    );
  }

  if (new Date(authToken.expires_at) < new Date()) {
    return (
      <ErrorScreen message="This link has expired. Please request a new checkout link from Discord." />
    );
  }

  if (authToken.is_used) {
    return <ErrorScreen message="This checkout link has already been used." />;
  }

  // Mark token as used
  await supabase
    .from("auth_tokens")
    .update({ is_used: true })
    .eq("token", token);

  // Fetch tab data
  const { data: tab, error: tabError } = await supabase
    .from("tabs")
    .select("*")
    .eq("id", tab_id)
    .single();

  if (tabError || !tab) {
    return <ErrorScreen message="Tab not found." />;
  }

  // Fetch receipt items
  const { data: items, error: itemsError } = await supabase
    .from("receipt_items")
    .select("*")
    .eq("tab_id", tab_id);

  if (itemsError || !items) {
    return <ErrorScreen message="Failed to load receipt items." />;
  }

  const typedTab = tab as Tab;
  const typedItems = items as ReceiptItem[];

  // Look up the user's display name from the users table
  const { data: userData } = await supabase
    .from("users")
    .select("username")
    .eq("discord_user_id", user)
    .single();

  const displayName = userData?.username ?? "Friend";

  // For even splits, look up the pre-calculated share from tab_assignments.
  // The bot writes these when the organizer selects people via the UserSelect
  // dropdown. We key on discord_user_id (from the `user` param) rather than the
  // display name so shared/duplicate usernames can't mismatch or collide.
  const { data: assignmentData } = await supabase
    .from("tab_assignments")
    .select("share_amount")
    .eq("tab_id", tab_id)
    .eq("discord_user_id", user)
    .maybeSingle();

  // Fallback: if no assignment row exists yet, just use the full total
  // (the bot should always create these, but this is a safety net)
  const shareAmount = assignmentData?.share_amount ?? typedTab.total_amount;

  return (
    <CheckoutClient
      tab={typedTab}
      items={typedItems}
      inviteeLabel={displayName}
      shareAmount={shareAmount}
    />
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="max-w-sm rounded-2xl bg-surface p-8 text-center shadow-lg">
        <div className="mb-4 text-4xl">&#x26A0;</div>
        <h1 className="mb-2 text-xl font-semibold">Access Denied</h1>
        <p className="text-muted">{message}</p>
      </div>
    </div>
  );
}
