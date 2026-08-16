export interface ReceiptItem {
  id: string;
  tab_id: string;
  item_name: string;
  unit_price: number; // cents
  quantity: number;
}

export interface Tab {
  id: string;
  creator_id: string;
  discord_channel_id: string;
  discord_guild_id: string | null;
  receipt_storage_url: string;
  total_amount: number; // cents
  split_type: "even" | "itemized";
  status: string;
}

export interface DiscordMember {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export interface AuthToken {
  token: string;
  discord_user_id: string;
  tab_id: string;
  expires_at: string;
  is_used: boolean;
}

export interface TabAssignment {
  id: string;
  tab_id: string;
  discord_user_id: string | null; // set for even splits; null for typed itemized labels
  invitee_label: string;
  share_amount: number; // cents
  item_ids: string[];
  paid: boolean;
  paid_at: string | null;
}
