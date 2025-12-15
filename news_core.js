const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const parser = new Parser({
  headers: {
    'User-Agent': 'vr-ar-ai-news-bot/1.0',
    'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
  },
});

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
    return [];
  }
}

async function summarizeWithGemini({ geminiApiKey, modelName, items }) {
  const ai = new GoogleGenAI({ apiKey: geminiApiKey });

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

async function buildNewsMessage({ rssFeeds, geminiApiKey, modelName }) {
  const feedList = (rssFeeds || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (feedList.length === 0) throw new Error('RSS_FEEDS saknas.');

  const PER_FEED = 10;
  const all = [];

  for (const url of feedList) {
    const items = await fetchFeedItemsSafe(url);
    all.push(...takeLatest(items, PER_FEED));
  }

  if (all.length === 0) {
    return '⚠️ Kunde inte läsa någon RSS-feed just nu (alla misslyckades).';
  }

  const totalLatest = takeLatest(all, 30);
  const summary = await summarizeWithGemini({ geminiApiKey, modelName, items: totalLatest });

  let out = '## 🗞️ Veckosummering (från våra källor)\n' + summary;
  if (out.length > 1900) out = out.slice(0, 1880) + '\n…(trunkerat)';
  return out;
}

module.exports = { buildNewsMessage };
