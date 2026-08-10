/**
 * One-time script to register the /receipt slash command with Discord.
 *
 * Run with:  npm run register
 *
 * Requires DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID environment variables
 * (set them in a .env file next to this script or export them in your shell).
 */

const DISCORD_API = "https://discord.com/api/v10";

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!TOKEN || !APP_ID) {
  console.error(
    "Set DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID environment variables.",
  );
  process.exit(1);
}

const commands = [
  {
    name: "receipt",
    description: "Upload a receipt image to start splitting a tab",
    options: [
      {
        name: "receipt",
        description: "The receipt image to process",
        type: 11, // ATTACHMENT
        required: true,
      },
    ],
  },
];

(async () => {
  const res = await fetch(
    `${DISCORD_API}/applications/${APP_ID}/commands`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    },
  );

  if (res.ok) {
    console.log("✅ Slash commands registered successfully.");
  } else {
    console.error("❌ Failed to register commands:", await res.text());
  }
})();
