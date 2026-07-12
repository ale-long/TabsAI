import os
import json
import asyncio
import discord
import secrets
from datetime import datetime, timedelta
from dotenv import load_dotenv
from supabase import create_client, Client
from groq import AsyncGroq
from psycopg_pool import AsyncConnectionPool
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from intent_engine import compile_intent_engine

# 1. Load Environment Variables
load_dotenv()
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
DB_URI = os.getenv("SUPABASE_DB_URI")

# Global variables for the pool and graph app
db_pool = None

import shared

# 2. Initialize Supabase Client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Global instantiation for optimal connection pooling
groq_client = AsyncGroq(api_key=GROQ_API_KEY)

# An prioritized list of vision models we know our system prompt supports
PREFERRED_VISION_MODELS = [
   "meta-llama/llama-4-scout-17b-16e-instruct",
   "qwen/qwen3.6-27b"
]

# 3. Configure Discord Client Intents
# The Message Content intent is strictly required to read message text and attachments
intents = discord.Intents.default()
intents.message_content = True  
client = discord.Client(intents=intents)

async def setup_db_pool():
    # Define the pool without opening it immediately
    pool = AsyncConnectionPool(
        conninfo=DB_URI,
        max_size=10, 
        open=False,
        kwargs={"autocommit": True}
    )
    
    # Explicitly open the pool
    await pool.open()
    return pool

@client.event
async def on_ready():
    global db_pool
    print(f'Gateway active. Logged in as {client.user}')

     # 1. Initialize the pool using the new pattern
    db_pool = await setup_db_pool()

    # 2. Pass the open pool to the checkpointer
    checkpointer = AsyncPostgresSaver(db_pool)

    # 3. Setup and Compile
    await checkpointer.setup()
    shared.app = compile_intent_engine(checkpointer)
    
    print("🧠 LangGraph state machine compiled with production-ready connection pooling.")

@client.event
async def on_message(message):
    # Ignore messages routed from the bot itself to prevent infinite loops
    if message.author == client.user:
        return

    # Phase 2 Binary Routing: Look exclusively for messages containing attachments  
    if message.attachments:
        for attachment in message.attachments:
            
            # Filter for image uploads (receipts)
            if attachment.content_type and attachment.content_type.startswith('image/'):
                print(f"Intercepted receipt upload from {message.author.name}...")
                
                discord_user_id = str(message.author.id)
                channel_id = str(message.channel.id)
                guild_id = str(message.guild.id) if message.guild else None
                
                # --- A. User Provisioning ---
                # Check if the user exists in our database based on their Discord ID
                user_res = supabase.table("users").select("id").eq("discord_user_id", discord_user_id).execute()
                
                if not user_res.data:
                    # Auto-provision the user if they are new
                    new_user = supabase.table("users").insert({
                        "discord_user_id": discord_user_id,
                        "username": str(message.author.name)
                    }).execute()
                    user_uuid = new_user.data[0]['id']
                else:
                    user_uuid = user_res.data[0]['id']

                # --- B. File Ingestion ---
                # Securely read the file bytes directly from Discord's CDN in memory
                image_bytes = await attachment.read()
                
                # Define a unique storage path: discord_user_id/message_id_filename
                storage_path = f"{discord_user_id}/{message.id}_{attachment.filename}"
                
                # Stream the bytes into the private Supabase Storage Bucket ('receipts')
                supabase.storage.from_("receipts").upload(
                    path=storage_path,
                    file=image_bytes,
                    file_options={"content-type": attachment.content_type}
                )
                
                # Retrieve the URL to pass to the Phase 3 Vision Node
                storage_url = supabase.storage.from_("receipts").get_public_url(storage_path)

                # --- C. State Creation ---
                # Log the new record in the `tabs` table
                tab_data = {
                    "creator_id": user_uuid,
                    "discord_channel_id": channel_id,
                    "discord_guild_id": guild_id,
                    "receipt_storage_url": storage_url,
                    "status": "pending_context" # Pauses state for Phase 3/4
                }
                tab_res = supabase.table("tabs").insert(tab_data).execute()
                
                # Acknowledge the upload natively in Discord
                tab_id = tab_res.data[0]['id']
                shared.active_channels[tab_id] = message.channel
                await message.reply(f"🧾 Receipt intercepted and uploaded to the DB! Initiating extraction sequence... (Tab ID: `{tab_id}`)")

                # This runs process_receipt_vision asynchronously without blocking the bot
                asyncio.create_task(process_receipt_vision(tab_id, storage_url, channel_id))

                # Break after the first image to prevent duplicate tabs if they upload a batch
                break

async def process_receipt_vision(tab_id: str, image_url: str, channel_id: str):
    """Background task to extract line items from a receipt image and update the database."""
    channel = shared.active_channels.get(tab_id)

    try:
        # 1. The Strict JSON System Prompt
        system_prompt = """
        You are a highly precise financial OCR engine. 
        Extract the line items, subtotal, tax, tip, and total from the provided receipt image.
        Ignore non-financial text (like restaurant addresses or 'thank you' messages).
        
        You MUST respond ONLY with a valid JSON object matching this exact schema:
        {
          "items": [
            {"item_name": "string", "unit_price": float, "quantity": integer}
          ],
          "subtotal": float,
          "tax": float,
          "tip": float,
          "total": float
        }
        Do not include markdown blocks, explanations, or any text outside the JSON object.
        """

        # 2. Call the Groq Vision Model
        print(f"[{tab_id}] Sending to Groq Vision...")
        response = await groq_client.chat.completions.create(
            model=PREFERRED_VISION_MODELS[0],
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": image_url}}
                    ]
                }
            ],
            temperature=0.1, # Low temperature for high precision
            response_format={"type": "json_object"} # Force JSON output
        )

        # 3. Parse the Output
        raw_json = response.choices[0].message.content
        receipt_data = json.loads(raw_json)
        print(f"[{tab_id}] Extraction successful, the receipt total is: ${receipt_data['total']}")

        # 4. Data Transformation (Float Dollars -> Integer Cents)
        # We use round() before int() to prevent floating point precision errors (e.g. 10.50 * 100 = 1049.999...)
        total_cents = int(round(receipt_data.get("total", 0) * 100))
        
        db_items = []
        for item in receipt_data.get("items", []):
            db_items.append({
                "tab_id": tab_id,
                "item_name": item["item_name"][:255], # Cap string length just in case
                "unit_price": int(round(item["unit_price"] * 100)),
                "quantity": item.get("quantity", 1)
            })

        # Add Tax and Tip as their own distinct line items so they can be split later if needed
        if receipt_data.get("tax", 0) > 0:
            db_items.append({"tab_id": tab_id, "item_name": "Tax", "unit_price": int(round(receipt_data["tax"] * 100)), "quantity": 1})
        if receipt_data.get("tip", 0) > 0:
            db_items.append({"tab_id": tab_id, "item_name": "Tip", "unit_price": int(round(receipt_data["tip"] * 100)), "quantity": 1})

        # 5. Database Transactions
        # A. Bulk insert all line items
        if db_items:
            supabase.table("receipt_items").insert(db_items).execute()
        
        # B. Update the parent tab with the grand total
        supabase.table("tabs").update({"total_amount": total_cents}).eq("id", tab_id).execute()

        # 6. Notify the user via Discord
        if channel:
            item_count = len(receipt_data.get("items", []))
            formatted_total = f"${receipt_data.get('total', 0):.2f}"
            await channel.send(f"✅ Extracted **{item_count} items** for a total of **{formatted_total}**! (Tab ID: `{tab_id}`)\n*Next up: Resolving split parameters...*")
        
        # 2. Trigger the engine (Pass NULL for state validation variables)
        # Let the engine query the DB and decide if it's valid
        if shared.app is None:
            print("❌ Error: Graph 'app' is not initialized yet. Waiting for bot to be ready...")
            return

        config = {"configurable": {"thread_id": tab_id}}
        initial_state = {
            "tab_id": tab_id,
            "channel_id": str(channel_id),
            "split_type": "null",
            "is_receipt_valid": True,
            "validation_issue": ""
        }
        await shared.app.ainvoke(initial_state, config)
        graph_state = await shared.app.aget_state(config)
        if not graph_state.next:
            shared.active_channels.pop(tab_id, None)

    except Exception as e:
        print(f"[{tab_id}] Error in Vision Node: {e}")
        shared.active_channels.pop(tab_id, None)
        if channel:
            await channel.send(f"❌ Failed to parse the receipt. Please try taking a clearer photo. Error: `{str(e)}`")

class SplitTypeView(discord.ui.View):
    def __init__(self, tab_id: str):
        # timeout=None ensures the buttons don't expire/break while waiting for a click
        super().__init__(timeout=None) 
        self.tab_id = tab_id

    @discord.ui.button(label="Split Evenly", style=discord.ButtonStyle.primary, custom_id="btn_even")
    async def even_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_selection(interaction, "even")

    @discord.ui.button(label="Itemize Split", style=discord.ButtonStyle.secondary, custom_id="btn_itemize")
    async def itemize_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self.handle_selection(interaction, "itemized")

    async def handle_selection(self, interaction: discord.Interaction, split_type: str):
        channel = shared.active_channels.get(self.tab_id)
        # 1. Acknowledge the click immediately to update the Discord UI
        await interaction.response.edit_message(
            content=f"✅ **{split_type.capitalize()}** split selected! Processing...", 
            view=None # Setting view=None removes the buttons so they can't be clicked twice
        )
        
        # 2. Update your main database row
        supabase.table("tabs").update({
            "split_type": split_type,
            "status": "active"
        }).eq("id", self.tab_id).execute()

        # Generate a cryptographically secure random string
        token = secrets.token_urlsafe(32) 

        # Save it to Supabase
        supabase.table("auth_tokens").insert({
            "token": token,
            "discord_user_id": str(interaction.user.id),
            "tab_id": self.tab_id,
            "expires_at": (datetime.now()+ timedelta(minutes=15)).isoformat(),
            "is_used": False
        }).execute()

        # 3. Un-freeze the LangGraph State Machine
        if shared.app:
            config = {"configurable": {"thread_id": self.tab_id}}

            # Because we are using an async Postgres checkpointer, we MUST use aupdate_state
            await shared.app.aupdate_state(config, {"split_type": split_type})

            # Invoke with 'None' to tell LangGraph to resume from the exact breakpoint
            print(f"[{self.tab_id}] Un-freezing graph state...")
            await shared.app.ainvoke(None, config)
            graph_state = await shared.app.aget_state(config)
            if not graph_state.next:
                shared.active_channels.pop(self.tab_id, None)
        else:
            print(f"❌ Error: Graph engine not found when resolving {self.tab_id}")
        
        if channel:
            # Send the UI link to Discord for checkout
            url = f"https://yourapp.com/split/{self.tab_id}?token={token}"
            await channel.send(f"💳 **Checkout Link:** {url}\n*This link is valid for 15 minutes.*")

class ReceiptFixView(discord.ui.View):
    def __init__(self, tab_id: str):
        # timeout=None ensures the view persists across bot restarts
        super().__init__(timeout=None)
        self.tab_id = tab_id

    @discord.ui.button(label="Approve Anyway", style=discord.ButtonStyle.success, custom_id="btn_approve_math")
    async def approve_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Overrides the math warning and continues the graph execution."""
        
        # 1. Update the Discord message so the user knows it worked
        await interaction.response.edit_message(
            content="✅ **Math warning overridden.** Proceeding with the extracted totals...",
            view=None
        )

        # 2. Un-freeze the LangGraph State Machine
        if shared.app:
            config = {"configurable": {"thread_id": self.tab_id}}

            # We force 'is_receipt_valid' to True so the graph knows the issue was handled
            await shared.app.aupdate_state(config, {"is_receipt_valid": True})

            print(f"[{self.tab_id}] Math override applied. Resuming from 'apply_fix' breakpoint...")

            # Invoke with None to resume execution down to the evaluate node
            await shared.app.ainvoke(None, config)
            graph_state = await shared.app.aget_state(config)
            if not graph_state.next:
                shared.active_channels.pop(self.tab_id, None)
        else:
            print(f"❌ Error: Graph engine not found when attempting to fix {self.tab_id}")

    @discord.ui.button(label="Cancel Tab", style=discord.ButtonStyle.danger, custom_id="btn_cancel_tab")
    async def cancel_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Aborts the process if the vision model completely botched the extraction."""
        
        # 1. Acknowledge and remove buttons
        await interaction.response.edit_message(
            content="🚫 **Tab cancelled.** Please try taking a clearer photo of the receipt and upload again.",
            view=None
        )
        
        # 2. Mark the tab as cancelled in Supabase so it doesn't show up in active queries
        try:
            # We wrap this in a to_thread if you are using the sync Supabase client, 
            # or just call it directly if you are managing it synchronously here
            supabase.table("tabs").update({"status": "cancelled"}).eq("id", self.tab_id).execute()
            print(f"[{self.tab_id}] Tab cancelled by user.")
        except Exception as e:
            print(f"[{self.tab_id}] Failed to cancel tab in database: {e}")
            
        # Note: We do not call ainvoke() here. The graph remains safely frozen at 
        # the 'apply_fix' breakpoint forever, which effectively kills the workflow.

# Run the Discord gateway
if __name__ == "__main__":
    client.run(DISCORD_BOT_TOKEN)