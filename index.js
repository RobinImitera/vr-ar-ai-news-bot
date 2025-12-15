require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { buildNewsMessage } = require('./news_core');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`Inloggad som ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!ping') {
    await message.channel.send('Botten är vaken! 🧠');
    return;
  }

  if (message.content === '!news') {
    try {
      await message.channel.send('⏳ Bygger veckosummering från RSS...');
      const msg = await buildNewsMessage({
        rssFeeds: process.env.RSS_FEEDS,
        geminiApiKey: process.env.GEMINI_API_KEY,
        modelName: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      });
      await message.channel.send(msg);
    } catch (e) {
      const msg = e?.message ? e.message : String(e);
      console.error('❌ !news fel:', e);
      await message.channel.send('❌ Kunde inte skapa nyheter.\n```' + msg + '```');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
