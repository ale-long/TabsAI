import os
import asyncio
from typing import TypedDict
from langgraph.graph import StateGraph, END
from supabase import create_client, Client
from dotenv import load_dotenv

# --- Initialize Supabase Client ---
load_dotenv()
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# --- 1. Define the State Schema ---
class TabState(TypedDict):
    tab_id: str
    channel_id: str
    split_type: str
    is_receipt_valid: bool       
    validation_issue: str        

# --- 2. Define the Nodes ---

async def validate_receipt(state: TabState):
    """Queries Supabase to validate if the extracted items match the total."""
    print(f"[{state['tab_id']}] Graph: Querying DB for validation...")
    
    # Run the synchronous Supabase SDK in a thread to keep the event loop unblocked
    def fetch_validation_data():
        tab_res = supabase.table("tabs").select("total_amount").eq("id", state['tab_id']).execute()
        items_res = supabase.table("receipt_items").select("unit_price, quantity").eq("tab_id", state['tab_id']).execute()
        return tab_res.data, items_res.data

    tab_data, items_data = await asyncio.to_thread(fetch_validation_data)
    
    if not tab_data:
        return {**state, "is_receipt_valid": False, "validation_issue": "Tab not found in database."}

    total_cents = tab_data[0].get("total_amount", 0)
    
    # Calculate sum accounting for potential quantities
    calculated_sum = sum(item.get("unit_price", 0) * item.get("quantity", 1) for item in items_data)
    
    is_valid = (calculated_sum == total_cents)
    issue_msg = ""
    
    if not is_valid:
        issue_msg = f"Database items total ${(calculated_sum/100):.2f}, but the grand total is ${(total_cents/100):.2f}."
        print(f"[{state['tab_id']}] Validation Failed: {issue_msg}")
    else:
        print(f"[{state['tab_id']}] Validation Passed: Totals match.")

    # Return the updated dictionary to merge into the LangGraph state
    return {**state, "is_receipt_valid": is_valid, "validation_issue": issue_msg}


async def ask_receipt_fix_discord(state: TabState):
    """Dispatches a Discord UI asking the user to manually verify/fix the receipt."""
    print(f"[{state['tab_id']}] Graph: Receipt invalid. Asking user for fix...")
    
    from bot import client, ReceiptFixView 
    
    channel = client.get_channel(int(state["channel_id"]))
    if channel:
        view = ReceiptFixView(tab_id=state["tab_id"])
        issue_text = state.get('validation_issue', 'Please manually verify the total.')
        await channel.send(f"⚠️ **Wait, the math isn't mathing on this receipt.**\n`{issue_text}`", view=view)
        
    return state


async def apply_receipt_fix(state: TabState):
    """Executes AFTER the user clicks the Discord button to fix the receipt."""
    # This node acts as a pass-through after the breakpoint.
    # The Discord UI webhook will have already updated Supabase and the Graph state.
    print(f"[{state['tab_id']}] Graph: User fix acknowledged. Proceeding...")
    return state


async def evaluate_tab_state(state: TabState):
    """Queries Supabase to get the absolute truth for split_type."""
    print(f"[{state['tab_id']}] Graph: Fetching split state from DB...")
    
    def fetch_split_type():
        return supabase.table("tabs").select("split_type").eq("id", state['tab_id']).execute()
        
    tab_data = await asyncio.to_thread(fetch_split_type)
    
    split_type = "null"
    if tab_data and tab_data.data:
        db_split = tab_data.data[0].get("split_type")
        if db_split:
            split_type = db_split
            
    print(f"[{state['tab_id']}] Current split_type resolved to: {split_type}")
    return {**state, "split_type": split_type}


async def send_clarification_discord(state: TabState):
    """Dispatches the Discord UI buttons to ask for the split type."""
    print(f"[{state['tab_id']}] Graph: Split missing. Dispatching UI buttons...")
    
    from bot import client, SplitTypeView 
    
    channel = client.get_channel(int(state["channel_id"]))

    if not channel:
        print(f"❌ Error: Bot could not find channel {state['channel_id']}. Check permissions.")
        return state
    
    try:
        view = SplitTypeView(tab_id=state["tab_id"])
        await channel.send(
            f"🧾 **Receipt Processed!** How would you like to split this?", 
            view=view
        )
        print(f"✅ UI buttons successfully dispatched to Discord.")
    except Exception as e:
        print(f"❌ Critical error sending UI: {e}")
    
    return state


async def process_split(state: TabState):
    """
    Confirms the split details by querying the DB. 
    This serves as our 'Final Verification' before Phase 5.
    """
    print(f"--- 📊 INTENT ENGINE: CONFIRMING SPLIT ---")
    
    def fetch_final_details():
        # Query the tab and the items to build a summary
        tab = supabase.table("tabs").select("*").eq("id", state['tab_id']).single().execute()
        items = supabase.table("receipt_items").select("*").eq("tab_id", state['tab_id']).execute()
        return tab.data, items.data

    tab, items = await asyncio.to_thread(fetch_final_details)
    
    split_type = tab.get("split_type")
    total = tab.get("total_amount") / 100
    
    print(f"Tab ID: {state['tab_id']}")
    print(f"Split Method: {split_type.upper()}")
    print(f"Total Amount: ${total:.2f}")
    print(f"Item Count: {len(items)}")
    
    if split_type == "itemized":
        print("Detail: Preparing item-level allocation...")
    else:
        print("Detail: Preparing equal distribution...")
        
    print(f"--- 🏁 CONFIRMATION COMPLETE ---")
    
    return state

# --- 3. Define Conditional Routing ---

def route_validation(state: TabState):
    if not state.get("is_receipt_valid", True):
        return "ask_fix"
    return "evaluate_split"

def route_split(state: TabState):
    if state.get("split_type") == "null":
        return "ask_user"
    return "process"

# --- 4. Build the Graph ---
workflow = StateGraph(TabState)

workflow.add_node("validate", validate_receipt)
workflow.add_node("ask_fix", ask_receipt_fix_discord)
workflow.add_node("apply_fix", apply_receipt_fix)
workflow.add_node("evaluate", evaluate_tab_state)
workflow.add_node("ask_user", send_clarification_discord)
workflow.add_node("process", process_split)

workflow.set_entry_point("validate")

# Routing
workflow.add_conditional_edges("validate", route_validation, {"ask_fix": "ask_fix", "evaluate_split": "evaluate"})
workflow.add_edge("ask_fix", "apply_fix")
workflow.add_edge("apply_fix", "evaluate")
workflow.add_conditional_edges("evaluate", route_split, {"ask_user": "ask_user", "process": "process"})
workflow.add_edge("ask_user", "process")
workflow.add_edge("process", END)

# --- 5. Export Compilation Function ---
def compile_intent_engine(checkpointer):
    return workflow.compile(
        checkpointer=checkpointer,
        interrupt_before=["apply_fix", "process"] 
    )