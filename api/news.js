// Serverless function: pulls 3 positive headlines from good-news RSS feeds.
// Cached at the edge for 6 hours so the morning load is instant.

const FEEDS = [
  { name: "Good News Network", url: "https://www.goodnewsnetwork.org/feed/" },
  { name: "Positive News", url: "https://www.positive.news/feed/" },
  { name: "Reasons to be Cheerful", url: "https://reasonstobecheerful.world/feed/" },
  { name: "Optimist Daily", url: "https://www.optimistdaily.com/feed/" },
];

// Skip anything that slipped into a "good news" feed but reads heavy.
const SKIP = /\b(dies|died|death|dead|killed|war|shooting|cancer|tragic|murder|attack|abuse|disaster|sponsored|podcast|webinar|donate)\b/i;

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]) : "";
}

async function readFeed(feed) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MorningMantra/1.0)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
    return items.slice(0, 15).map((it) => ({
      title: tag(it, "title"),
      link: tag(it, "link"),
      date: tag(it, "pubDate"),
      source: feed.name,
    })).filter((i) => i.title && i.link && !SKIP.test(i.title));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  const results = await Promise.all(FEEDS.map(readFeed));

  // Round-robin across sources so the 3 headlines come from different places.
  const picks = [];
  const seen = new Set();
  for (let round = 0; picks.length < 3 && round < 15; round++) {
    for (const list of results) {
      const item = list[round];
      if (!item) continue;
      const key = item.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push(item);
      if (picks.length === 3) break;
    }
  }

  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
  res.status(200).json({ headlines: picks, fetchedAt: new Date().toISOString() });
}
