require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleGenAI } = require('@google/genai');
const Parser = require('rss-parser');
const cron = require('node-cron');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const parser = new Parser();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchFeedItems(feedUrl) {
  const feed = await parser.parseURL(feedUrl);
  const items = feed.items || [];
  return items.map((it) => ({
    source: feed.title || feedUrl,
    title: it.title || '(utan titel)',
    link: it.link || '',
    date: it.isoDate || it.pubDate || it.published || it.updated || '',
  }));
}

// Ta de senaste N artiklarna (sortera efter datum om möjligt, annars behåll ordningen)
function takeLatest(items, n) {
  const withDate = items
    .map((it) => ({ ...it, _d: new Date(it.date || 0) }))
    .map((it) => ({ ...it, _valid: it._d.toString() !== 'Invalid Date' && it.date }));

  const anyValid = withDate.some((it) => it._valid);

  if (anyValid) {
    withDate.sort((a, b) => (b._d - a._d));
  }
  return withDate.slice(0, n).map(({ _d, _valid, ...rest }) => rest);
}

async function summarizeWeekly(items) {
  const modelName = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

  const lines = items.map((it, i) => {
    const d = it.date ? ` (${String(it.date).slice(0, 10)})` : '';
    return `${i + 1}. [${it.source}] ${it.title}${d}\n${it.link}`;
  }).join('\n\n');

  const prompt = `
Du skriver en VECKOSUMMERING för utvecklare inom VR/AR/XR/AI.

Utgå ENBART från artikellistan nedan (gissa inte).

KRAV:
- Svara på svenska
- Max 5 punkter
- Max 1–2 meningar per punkt
- Totalt MAX 1500 tecken
- Fokusera på dev-relevanta saker (SDK, standarder, ramverk, verktyg, plattformar, releases)
- Om listan är tunn: skriv färre punkter hellre än att hitta på
- Avsluta med: "Källor:" och lista 3–6 viktigaste länkar

ARTIKLAR:
${lines}
`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({ model: modelName, contents: prompt });
      return result.text;
    } catch (e) {
      lastErr = e;
      const msg = e?.message ? e.message : String(e);
      const overloaded = msg.includes('503') || msg.toLowerCase().includes('overloaded') || msg.toLowerCase().includes('unavailable');
      if (!overloaded) throw e;
      await sleep(attempt === 1 ? 1500 : attempt === 2 ? 3000 : 5000);
    }
  }
  throw lastErr;
}

async function postWeeklySummary(channel) {
  const feedList = (process.env.RSS_FEEDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (feedList.length === 0) {
    await channel.send('⚠️ Ingen RSS_FEEDS är satt i .env');
    return;
  }

  const PER_FEED = 10; // senaste 10 per feed
  const all = [];

  for (const url of feedList) {
    try {
      const items = await fetchFeedItems(url);
      const latest = takeLatest(items, PER_FEED);
      all.push(...latest);
    } catch (e) {
      console.error('Feed-fel:', url, e?.message || e);
    }
  }

  if (all.length === 0) {
    await channel.send('🗓️ Jag kunde inte hämta några artiklar från dina RSS-feeds just nu.');
    return;
  }

  // Ta totalt max 30 artiklar (så prompten inte blir enorm)
  const totalLatest = takeLatest(all, 30);

  const summary = await summarizeWeekly(totalLatest);

  const header = '## 🗞️ Veckosummering (senaste artiklarna från våra källor)\n';
  let out = header + summary;

  // Extra säkerhet mot Discords 2000-teckensgräns
  if (out.length > 1900) out = out.slice(0, 1880) + '\n…(trunkerat)';

  await channel.send(out);
}

client.once('ready', async () => {
  console.log(`Inloggad som ${client.user.tag}`);

  // Schemalägg: varje måndag 09:00 (Stockholm)
  cron.schedule(
    '0 9 * * 1',
    async () => {
      try {
        const channelId = process.env.NEWS_CHANNEL_ID;
        const channel = await client.channels.fetch(channelId);
        await postWeeklySummary(channel);
      } catch (e) {
        console.error('Schema-fel:', e?.message || e);
      }
    },
    { timezone: 'Europe/Stockholm' }
  );

  console.log('✅ Schema aktivt: måndag 09:00 (Europe/Stockholm)');
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (message.content === '!ping') {
    await message.channel.send('Botten är vaken! 🧠');
    return;
  }

  // Manuell test: kör veckosummering direkt
  if (message.content === '!news') {
    try {
      await message.channel.send('⏳ Bygger veckosummering från RSS (senaste artiklarna)...');
      await postWeeklySummary(message.channel);
    } catch (e) {
      console.error('Weekly-fel:', e?.message || e);
      await message.channel.send('❌ Kunde inte skapa veckosummering.\n```' + (e?.message || String(e)) + '```');
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
