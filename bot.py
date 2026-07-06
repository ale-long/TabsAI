import os
import json
import asyncio
import discord
from dotenv import load_dotenv
from supabase import create_client, Client
from groq import AsyncGroq

# 1. Load Environment Variables
load_dotenv()
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

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

@client.event
async def on_ready():
    print(f'Gateway active. Logged in as {client.user}')

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
                await message.reply(f"🧾 Receipt intercepted and uploaded to the DB! Initiating extraction sequence... (Tab ID: `{tab_id}`)")
                
                 # This runs process_receipt_vision asynchronously without blocking the bot
                asyncio.create_task(process_receipt_vision(tab_id, storage_url, channel_id))

                # Break after the first image to prevent duplicate tabs if they upload a batch
                break

async def process_receipt_vision(tab_id: str, image_url: str, channel_id: str):
    """Background task to extract line items from a receipt image and update the database."""
    channel = client.get_channel(int(channel_id))
    
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

    except Exception as e:
        print(f"[{tab_id}] Error in Vision Node: {e}")
        if channel:
            await channel.send(f"❌ Failed to parse the receipt. Please try taking a clearer photo. Error: `{str(e)}`")

# Run the Discord gateway
if __name__ == "__main__":
    client.run(DISCORD_BOT_TOKEN)