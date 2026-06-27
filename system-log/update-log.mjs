// update-log.mjs — builds entries.json for the live system log.
// Pulls recent are.na saves + Letterboxd watches, merges, sorts, trims.
// No dependencies; Node 20+ (global fetch).

import { writeFile } from "node:fs/promises";

const ARENA_SLUG = "stuff-zcbcavantta";
const LETTERBOXD_USER = "jongoldman";
const MAX_ROWS = 10; // how deep the log runs — change here

// ── are.na ──────────────────────────────────────────────────────────
export function parseArena(json) {
  const blocks = json?.contents ?? [];
  return blocks
    .filter(b => b && b.class !== "Channel" && b.connected_at)
    .map(b => ({
      date: String(b.connected_at).slice(0, 10),
      action: "saved",
      item: clean(b.title || b.generated_title || b.class || "untitled"),
      source: "are.na",
      url: "https://www.are.na/block/" + b.id,
    }));
}

async function fetchArena() {
  const url = `https://api.are.na/v2/channels/${ARENA_SLUG}/contents?per=100&direction=desc`;
  const res = await fetch(url, { headers: { "User-Agent": "live-system-log" } });
  if (!res.ok) throw new Error(`are.na ${res.status}`);
  return parseArena(await res.json());
}

// ── Letterboxd (RSS) ────────────────────────────────────────────────
export function parseLetterboxd(xml) {
  const items = String(xml).split("<item>").slice(1);
  const out = [];
  for (const raw of items) {
    const date = pick(raw, "letterboxd:watchedDate");
    const film = pick(raw, "letterboxd:filmTitle");
    if (!date || !film) continue; // skip lists / non-diary items
    out.push({
      date: date.slice(0, 10),
      action: "watched",
      item: clean(film),
      source: "letterboxd",
      url: pick(raw, "link") || undefined,
    });
  }
  return out;
}

async function fetchLetterboxd() {
  const url = `https://letterboxd.com/${LETTERBOXD_USER}/rss/`;
  const res = await fetch(url, { headers: { "User-Agent": "live-system-log" } });
  if (!res.ok) throw new Error(`letterboxd ${res.status}`);
  return parseLetterboxd(await res.text());
}

// ── helpers ─────────────────────────────────────────────────────────
function pick(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}
function clean(s) {
  return String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 70);
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  const results = await Promise.allSettled([fetchArena(), fetchLetterboxd()]);
  let entries = [];
  for (const r of results) {
    if (r.status === "fulfilled") entries = entries.concat(r.value);
    else console.error("source failed:", r.reason?.message || r.reason);
  }
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  entries = entries.slice(0, MAX_ROWS);
  await writeFile("entries.json", JSON.stringify(entries, null, 2) + "\n");
  console.log(`wrote ${entries.length} rows`);
}

// only run main() when executed directly (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}`) main();
