require('dotenv').config();
const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Viktigt: sätt User-Agent så fler feeds beter sig “snällt”
const parser = new Parser({
  headers: {
    'User-Agent': 'vr-ar-ai-news-bot/1.0 (GitHub Actions)',
    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function takeLatest(items, n) {
  const withDate = items
    .map((it) => ({ ...it, _d: new Date(it.date || 0) }))
    .map((it) => ({ ...it, _valid: it._d.toString() !== 'Invalid Date' && it.date }));

  const anyValid = withDate.some((it) => it._valid);
  if (anyValid) withDate.sort((a, b) => (b._d - a._d));
  return withDate.slice(0, n).map(({ _d, _valid, ...rest }) => rest);
}

async function fetchFeedItemsSafe(feedUrl) {
  try {
    const feed = await parser.parseURL(feedUrl);
    const items = feed.items || [];
    return items.map((it) => ({
      source: feed.title || feedUrl,
      title: it.title || '(utan titel)',
      link: it.link || '',
      date: it.isoDate || it.pubDate || it.published || it.updated || '',
    }));
  } catch (e) {
    console.error(`⚠️ Skippade trasig/otillgänglig feed: ${feedUrl}`);
    console.error(e?.message || e);
    return []; // <-- viktig: krascha inte hela jobbet
  }
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

  let lastErr = null;

  // Retry vid 503/overloaded
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await ai.models.generateContent({ model: modelName, contents: prompt });
      return result.text;
    } catch (e) {
      lastErr = e;
      const msg = e?.message ? e.message : String(e);
      const overloaded =
        msg.includes('503') ||
        msg.toLowerCase().includes('overloaded') ||
        msg.toLowerCase().includes('unavailable');

      if (!overloaded) throw e;

      const waitMs = attempt === 1 ? 1500 : attempt === 2 ? 3000 : 5000;
      console.log(`⚠️ Gemini överbelastad (503). Försök ${attempt}/3. Väntar ${waitMs}ms...`);
      await sleep(waitMs);
    }
  }

  throw lastErr;
}

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
  const feedList = (process.env.RSS_FEEDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (feedList.length === 0) throw new Error('RSS_FEEDS saknas (GitHub Secret).');

  const PER_FEED = 10;
  const all = [];

  for (const url of feedList) {
    const items = await fetchFeedItemsSafe(url);
    const latest = takeLatest(items, PER_FEED);
    all.push(...latest);
  }

  if (all.length === 0) {
    await postToDiscordChannel('⚠️ Kunde inte läsa någon RSS-feed just nu (alla misslyckades).');
    return;
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
  .catch(async (e) => {
    const msg = e?.message ? e.message : String(e);
    console.error('❌ Fel:', e);

    // Om Gemini är överbelastad: posta info och avsluta som "success"
    if (
      msg.includes('503') ||
      msg.toLowerCase().includes('overloaded') ||
      msg.toLowerCase().includes('unavailable')
    ) {
      try {
        await postToDiscordChannel(
          '⚠️ Veckosummering kunde inte genereras just nu (Gemini överbelastad). Jag försöker igen nästa schemalagda körning.'
        );
      } catch (postErr) {
        console.error('Kunde inte posta fallback-meddelande:', postErr?.message || postErr);
      }
      process.exit(0);
    }

    process.exit(1);
  });
