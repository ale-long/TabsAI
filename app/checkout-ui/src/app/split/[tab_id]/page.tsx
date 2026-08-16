import { createSupabaseServerClient } from "@/lib/supabase";
import type { Tab, ReceiptItem, DiscordMember } from "@/lib/types";
import SplitTaggerClient from "./SplitTaggerClient";
import CheckoutClient from "./CheckoutClient";

const DISCORD_API = "https://discord.com/api/v10";

async function fetchGuildMembers(guildId: string): Promise<DiscordMember[]> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return [];

  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=100`, {
    headers: { Authorization: `Bot ${botToken}` },
  });

  if (!res.ok) return [];

  const members: any[] = await res.json();
  return members
    .filter((m) => !m.user.bot)
    .map((m) => ({
      id: m.user.id,
      username: m.user.username,
      display_name: m.nick || m.user.global_name || m.user.username,
      avatar_url: m.user.avatar
        ? `https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png?size=64`
        : null,
    }));
}

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

  // Fetch guild members for the organizer's split tagger view
  const guildMembers = typedTab.discord_guild_id
    ? await fetchGuildMembers(typedTab.discord_guild_id)
    : [];

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
      guildMembers={guildMembers}
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
