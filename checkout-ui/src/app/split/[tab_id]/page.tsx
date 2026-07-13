import { createSupabaseServerClient } from "@/lib/supabase";
import type { Tab, ReceiptItem } from "@/lib/types";
import SplitTaggerClient from "./SplitTaggerClient";
import CheckoutClient from "./CheckoutClient";

interface PageProps {
  params: Promise<{ tab_id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SplitPage({ params, searchParams }: PageProps) {
  const { tab_id } = await params;
  const { token, invitee } = await searchParams;

  if (!token || typeof token !== "string") {
    return <ErrorScreen message="Missing or invalid authentication token." />;
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
    return <ErrorScreen message="Invalid or expired link. Please request a new one from Discord." />;
  }

  // Check expiration
  if (new Date(authToken.expires_at) < new Date()) {
    return <ErrorScreen message="This link has expired. Please request a new checkout link from Discord." />;
  }

  // Check if already used (for invitee checkout tokens)
  if (authToken.is_used && invitee) {
    return <ErrorScreen message="This checkout link has already been used." />;
  }

  // Mark token as used for single-use invitee flows
  if (invitee) {
    await supabase
      .from("auth_tokens")
      .update({ is_used: true })
      .eq("token", token);
  }

  // Fetch the tab data
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

  // If invitee param is present, show checkout view
  if (invitee && typeof invitee === "string") {
    // Look up this invitee's assigned share from tab_assignments
    const { data: assignmentData } = await supabase
      .from("tab_assignments")
      .select("share_amount")
      .eq("tab_id", tab_id)
      .eq("invitee_label", invitee)
      .single();

    const shareAmount = assignmentData?.share_amount ?? typedTab.total_amount;

    return (
      <CheckoutClient
        tab={typedTab}
        items={typedItems}
        inviteeLabel={invitee}
        shareAmount={shareAmount}
      />
    );
  }

  // Otherwise, show the organizer's split tagger view
  return (
    <SplitTaggerClient
      tab={typedTab}
      items={typedItems}
      token={token}
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
