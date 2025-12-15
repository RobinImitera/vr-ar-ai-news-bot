require('dotenv').config();
const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');

const parser = new Parser();
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function takeLatest(items, n) {
  const withDate = items
    .map((it) => ({ ...it, _d: new Date(it.date || 0) }))
    .map((it) => ({ ...it, _valid: it._d.toString() !== 'Invalid Date' && it.date }));

  const anyValid = withDate.some((it) => it._valid);
  if (anyValid) withDate.sort((a, b) => (b._d - a._d));
  return withDate.slice(0, n).map(({ _d, _valid, ...rest }) => rest);
}

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

async function summarize(items) {
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
- Avsluta med: "Källor:" och lista 3–6 viktigaste länkar

ARTIKLAR:
${lines}
`;

  const result = await ai.models.generateContent({ model: modelName, contents: prompt });
  return result.text;
}

async function postToDiscordChannel(content) {
  const channelId = process.env.NEWS_CHANNEL_ID;
  const token = process.env.DISCORD_TOKEN;

  if (!channelId) throw new Error('NEWS_CHANNEL_ID saknas i .env');
  if (!token) throw new Error('DISCORD_TOKEN saknas i .env');

  // Discord Create Message: POST /channels/{channel.id}/messages (Bot token auth)
  // (Discord docs beskriver bot-token auth i API Reference.) 
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
  const feedList = (process.env.RSS_FEEDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (feedList.length === 0) throw new Error('RSS_FEEDS saknas i .env');

  const PER_FEED = 10;
  const all = [];

  for (const url of feedList) {
    const items = await fetchFeedItems(url);
    all.push(...takeLatest(items, PER_FEED));
  }

  const totalLatest = takeLatest(all, 30);
  const summary = await summarize(totalLatest);

  let out = '## 🗞️ Veckosummering (från våra källor)\n' + summary;
  if (out.length > 1900) out = out.slice(0, 1880) + '\n…(trunkerat)';

  await postToDiscordChannel(out);
}

main()
  .then(() => {
    console.log('✅ Klart. Postat i Discord.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('❌ Fel:', e);
    process.exit(1);
  });
