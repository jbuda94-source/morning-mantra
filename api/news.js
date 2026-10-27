// Serverless function: 3 local headlines for Long Beach and Orange County.
// Two from Long Beach sources, one from Orange County, newest first.
// Cached at the edge for 1 hour.

const FEEDS = {
  longBeach: [
    { name: "Long Beach Post", url: "https://lbpost.com/feed/" },
    { name: "Long Beach Business Journal", url: "https://lbbusinessjournal.com/feed/" },
    { name: "Long Beach Watchdog", url: "https://thelongbeachwatchdog.com/feed/" },
  ],
  orangeCounty: [
    { name: "Voice of OC", url: "https://voiceofoc.org/feed/" },
    { name: "OC Register", url: "https://www.ocregister.com/news/local-news/feed/" },
    { name: "Daily Pilot", url: "https://www.latimes.com/socal/daily-pilot/rss2.0.xml" },
  ],
};

const SKIP = /\b(sponsored|advertorial|podcast|newsletter|crossword|horoscope)\b/i;

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
    return items.slice(0, 20).map((it) => ({
      title: tag(it, "title"),
      link: tag(it, "link"),
      time: Date.parse(tag(it, "pubDate")) || 0,
      source: feed.name,
    })).filter((i) => i.title && i.link && !SKIP.test(i.title));
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

// Newest stories across a region's feeds, at most one per source until each has had a turn.
async function region(feeds) {
  const lists = await Promise.all(feeds.map(readFeed));
  const all = lists.flat().sort((a, b) => b.time - a.time);
  const bySource = new Map();
  for (const item of all) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }
  const out = [];
  for (let round = 0; round < 20; round++) {
    const batch = [];
    for (const list of bySource.values()) if (list[round]) batch.push(list[round]);
    if (!batch.length) break;
    out.push(...batch.sort((a, b) => b.time - a.time));
  }
  return out;
}

export default async function handler(req, res) {
  const [lb, oc] = await Promise.all([region(FEEDS.longBeach), region(FEEDS.orangeCounty)]);

  const picks = [];
  const seen = new Set();
  const take = (list, n, area) => {
    for (const item of list) {
      if (picks.filter((p) => p.area === area).length >= n) break;
      const key = item.title.toLowerCase().slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({ title: item.title, link: item.link, source: item.source, area });
    }
  };
  take(lb, 2, "Long Beach");
  take(oc, 1, "Orange County");
  // If one region came back empty, fill from the other.
  if (picks.length < 3) take(lb, 3 - picks.filter((p) => p.area === "Orange County").length, "Long Beach");
  if (picks.length < 3) take(oc, 3 - picks.filter((p) => p.area === "Long Beach").length, "Orange County");

  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=21600");
  res.status(200).json({ headlines: picks.slice(0, 3), fetchedAt: new Date().toISOString() });
}
