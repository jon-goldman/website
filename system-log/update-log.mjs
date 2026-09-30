// update-log.mjs — builds entries.json for the live system log.
// Pulls recent are.na saves + Letterboxd watches, merges, sorts, trims.
// No dependencies; Node 20+ (global fetch).

import { readFile, writeFile } from "node:fs/promises";

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
  const t = String(s)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= 64) return t;
  return t.slice(0, 64).replace(/\s*\S*$/, "").trim() + "…"; // back off to last whole word
}

// ── main ────────────────────────────────────────────────────────────
// A source that fails keeps its rows from the last good run. Without this the
// other source silently filled all ten rows, so the log flipped between
// all-are.na and all-Letterboxd whenever one fetch blipped (8/29, 9/2, 9/3, 9/9).
export function mergeWithFallback(results, previous) {
  const sources = ["are.na", "letterboxd"];
  let entries = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") entries = entries.concat(r.value);
    else {
      failed.push(sources[i]);
      entries = entries.concat((previous ?? []).filter(e => e.source === sources[i]));
    }
  });
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { entries: entries.slice(0, MAX_ROWS), failed };
}

async function readPrevious() {
  try {
    const data = JSON.parse(await readFile("entries.json", "utf8"));
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

async function main() {
  const results = await Promise.allSettled([fetchArena(), fetchLetterboxd()]);
  results.forEach(r => {
    if (r.status === "rejected") console.error("source failed:", r.reason?.message || r.reason);
  });
  if (results.every(r => r.status === "rejected")) {
    // Leave entries.json (and its "synced" time) untouched and fail the run,
    // so GitHub emails about it instead of the log quietly going stale.
    console.error("both sources failed — entries.json left as it was");
    process.exit(1);
  }
  const { entries, failed } = mergeWithFallback(results, await readPrevious());
  const payload = { updated: new Date().toISOString(), entries };
  await writeFile("entries.json", JSON.stringify(payload, null, 2) + "\n");
  console.log(`wrote ${entries.length} rows` +
    (failed.length ? ` (kept last good rows for: ${failed.join(", ")})` : ""));
}

// only run main() when executed directly (not when imported for tests)
if (import.meta.url === `file://${process.argv[1]}`) main();
