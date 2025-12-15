require('dotenv').config();
const { buildNewsMessage } = require('./news_core');

async function postToDiscordChannel(content) {
  const channelId = process.env.NEWS_CHANNEL_ID;
  const token = process.env.DISCORD_TOKEN;

  if (!channelId) throw new Error('NEWS_CHANNEL_ID saknas (GitHub Secret).');
  if (!token) throw new Error('DISCORD_TOKEN saknas (GitHub Secret).');

  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Discord API fel (${res.status}): ${txt}`);
  }
}

async function main() {
  const msg = await buildNewsMessage({
    rssFeeds: process.env.RSS_FEEDS,
    geminiApiKey: process.env.GEMINI_API_KEY,
    modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  });

  await postToDiscordChannel(msg);
}

main()
  .then(() => {
    console.log('✅ Klart. Postat i Discord.');
    process.exit(0);
  })
  .catch(async (e) => {
    const msg = e?.message ? e.message : String(e);
    console.error('❌ Fel:', e);

    // Om Gemini är överbelastad: posta info och avsluta som "success"
    if (msg.includes('503') || msg.toLowerCase().includes('overloaded') || msg.toLowerCase().includes('unavailable')) {
      try {
        await postToDiscordChannel('⚠️ Veckosummering kunde inte genereras just nu (Gemini överbelastad). Jag försöker igen nästa schemalagda körning.');
      } catch (postErr) {
        console.error('Kunde inte posta fallback-meddelande:', postErr?.message || postErr);
      }
      process.exit(0);
    }

    process.exit(1);
  });
