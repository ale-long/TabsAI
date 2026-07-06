import os
import discord
from dotenv import load_dotenv
from supabase import create_client, Client

# 1. Load Environment Variables
load_dotenv()
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

# 2. Initialize Supabase Client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

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
                await message.reply(f"🧾 Receipt intercepted and uploaded to the DB! (Tab ID: `{tab_id}`)")
                
                # Break after the first image to prevent duplicate tabs if they upload a batch
                break

# Run the Discord gateway
if __name__ == "__main__":
    client.run(DISCORD_BOT_TOKEN)