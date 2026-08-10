import { SupabaseClient } from "@supabase/supabase-js";

const DISCORD_API = "https://discord.com/api/v10";

const ComponentType = { ACTION_ROW: 1, BUTTON: 2 } as const;
const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
} as const;

// Mirrors intent_engine.py's TabState TypedDict
interface TabState {
  tab_id: string;
  channel_id: string;
  split_type: string;
  is_receipt_valid: boolean;
  validation_issue: string;
}

function buildSplitTypeButtons(tabId: string) {
  return [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.PRIMARY,
          label: "Split Evenly",
          custom_id: `btn_even:${tabId}`,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SECONDARY,
          label: "Itemize Split",
          custom_id: `btn_itemize:${tabId}`,
        },
      ],
    },
  ];
}

function buildReceiptFixButtons(tabId: string) {
  return [
    {
      type: ComponentType.ACTION_ROW,
      components: [
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.SUCCESS,
          label: "Approve Anyway",
          custom_id: `btn_approve_math:${tabId}`,
        },
        {
          type: ComponentType.BUTTON,
          style: ButtonStyle.DANGER,
          label: "Cancel Tab",
          custom_id: `btn_cancel_tab:${tabId}`,
        },
      ],
    },
  ];
}

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

// ---------------------------------------------------------------------------
// Intent Engine — translates the LangGraph StateGraph from intent_engine.py.
//
// The original uses interrupt_before=["apply_fix", "process"] to pause the
// graph and wait for Discord button input.  In the serverless model we achieve
// the same effect by returning from the engine function; the button webhook
// handler calls the appropriate resume method to continue.
// ---------------------------------------------------------------------------

export class IntentEngine {
  constructor(
    private supabase: SupabaseClient,
    private botToken: string,
  ) {}

  // --- Node: validate_receipt ---
  private async validateReceipt(tabId: string): Promise<TabState> {
    console.log(`[${tabId}] Graph: Querying DB for validation...`);

    const { data: tabData } = await this.supabase
      .from("tabs")
      .select("total_amount, discord_channel_id")
      .eq("id", tabId);

    const { data: itemsData } = await this.supabase
      .from("receipt_items")
      .select("unit_price, quantity")
      .eq("tab_id", tabId);

    if (!tabData || tabData.length === 0) {
      return {
        tab_id: tabId,
        channel_id: "",
        split_type: "null",
        is_receipt_valid: false,
        validation_issue: "Tab not found in database.",
      };
    }

    const totalCents: number = tabData[0].total_amount ?? 0;
    const channelId: string = tabData[0].discord_channel_id ?? "";

    const calculatedSum = (itemsData ?? []).reduce(
      (sum, item) => sum + (item.unit_price ?? 0) * (item.quantity ?? 1),
      0,
    );

    const isValid = calculatedSum === totalCents;
    let issueMsg = "";

    if (!isValid) {
      issueMsg = `Database items total $${(calculatedSum / 100).toFixed(2)}, but the grand total is $${(totalCents / 100).toFixed(2)}.`;
      console.log(`[${tabId}] Validation Failed: ${issueMsg}`);
    } else {
      console.log(`[${tabId}] Validation Passed: Totals match.`);
    }

    return {
      tab_id: tabId,
      channel_id: channelId,
      split_type: "null",
      is_receipt_valid: isValid,
      validation_issue: issueMsg,
    };
  }

  // --- Node: ask_receipt_fix_discord ---
  private async askReceiptFix(
    tabId: string,
    channelId: string,
    issueText: string,
  ): Promise<void> {
    console.log(`[${tabId}] Graph: Receipt invalid. Asking user for fix...`);

    await sendChannelMessage(
      this.botToken,
      channelId,
      `⚠️ **Wait, the math isn't mathing on this receipt.**\n\`${issueText}\``,
      buildReceiptFixButtons(tabId),
    );
  }

  // --- Node: evaluate_tab_state ---
  private async evaluateTabState(tabId: string): Promise<string> {
    console.log(`[${tabId}] Graph: Fetching split state from DB...`);

    const { data } = await this.supabase
      .from("tabs")
      .select("split_type")
      .eq("id", tabId);

    let splitType = "null";
    if (data && data.length > 0 && data[0].split_type) {
      splitType = data[0].split_type;
    }

    console.log(`[${tabId}] Current split_type resolved to: ${splitType}`);
    return splitType;
  }

  // --- Node: send_clarification_discord ---
  private async sendClarification(
    tabId: string,
    channelId: string,
  ): Promise<void> {
    console.log(`[${tabId}] Graph: Split missing. Dispatching UI buttons...`);

    await sendChannelMessage(
      this.botToken,
      channelId,
      "🧾 **Receipt Processed!** How would you like to split this?",
      buildSplitTypeButtons(tabId),
    );

    console.log("✅ UI buttons successfully dispatched to Discord.");
  }

  // --- Node: process_split ---
  private async processSplit(tabId: string): Promise<void> {
    console.log("--- 📊 INTENT ENGINE: CONFIRMING SPLIT ---");

    const { data: tab } = await this.supabase
      .from("tabs")
      .select("*")
      .eq("id", tabId)
      .single();

    const { data: items } = await this.supabase
      .from("receipt_items")
      .select("*")
      .eq("tab_id", tabId);

    const splitType = tab?.split_type ?? "unknown";
    const total = (tab?.total_amount ?? 0) / 100;

    console.log(`Tab ID: ${tabId}`);
    console.log(`Split Method: ${splitType.toUpperCase()}`);
    console.log(`Total Amount: $${total.toFixed(2)}`);
    console.log(`Item Count: ${(items ?? []).length}`);

    if (splitType === "itemized") {
      console.log("Detail: Preparing item-level allocation...");
    } else {
      console.log("Detail: Preparing equal distribution...");
    }

    console.log("--- 🏁 CONFIRMATION COMPLETE ---");
  }

  // ---------------------------------------------------------------------------
  // Engine execution — mirrors the compiled LangGraph with breakpoints.
  //
  // run()             → full flow from validate (entry point)
  // resumeFromFix()   → resumes after the user approves a math override
  //                      (equivalent to resuming from the "apply_fix" breakpoint)
  // resumeWithSplit() → resumes after the user selects a split type
  //                      (equivalent to resuming from the "process" breakpoint)
  // ---------------------------------------------------------------------------

  async run(tabId: string, channelId: string): Promise<void> {
    // validate → route_validation
    const state = await this.validateReceipt(tabId);
    const resolvedChannelId = state.channel_id || channelId;

    if (!state.is_receipt_valid) {
      // ask_fix → PAUSE (interrupt_before: apply_fix)
      await this.askReceiptFix(
        tabId,
        resolvedChannelId,
        state.validation_issue || "Please manually verify the total.",
      );
      return;
    }

    // evaluate → route_split
    const splitType = await this.evaluateTabState(tabId);

    if (splitType === "null") {
      // ask_user → PAUSE (interrupt_before: process)
      await this.sendClarification(tabId, resolvedChannelId);
      return;
    }

    // process → END
    await this.processSplit(tabId);
  }

  async resumeFromFix(tabId: string, channelId: string): Promise<void> {
    console.log(`[${tabId}] Math override applied. Resuming from apply_fix...`);

    // apply_fix is a pass-through; continue to evaluate
    const splitType = await this.evaluateTabState(tabId);

    if (splitType === "null") {
      await this.sendClarification(tabId, channelId);
      return;
    }

    await this.processSplit(tabId);
  }

  async resumeWithSplit(tabId: string): Promise<void> {
    console.log(`[${tabId}] Un-freezing graph state...`);
    await this.processSplit(tabId);
  }
}
