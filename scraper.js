// Builds circuits.json from two NSE sources. Zero npm dependencies — Node 18+.
//
// 1. Base:    sec_list.csv — full security-wise price band list
//             (Symbol,Series,Security Name,Band,Remarks; Band = 2/5/10/20/40 or "No Band")
// 2. Overlay: eq_band_changes_DDMMYYYY.csv — published every trading evening at
//             https://www.nseindia.com/reports/price-band-changes with the bands
//             effective from the NEXT trade date
//             (Sr. No,Symbol,Series,Security Name,From,To)

import { writeFileSync, readFileSync, existsSync } from "fs";

const SOURCE_URL = "https://nsearchives.nseindia.com/content/equities/sec_list.csv";
const CHANGES_URL_BASE = "https://nsearchives.nseindia.com/content/equities/eq_band_changes_";
const OUT_FILE = "circuits.json";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Minimal CSV parser that handles quoted fields (names/remarks can contain commas)
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { fields.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

async function fetchCsv(url, { headerPrefix, minLength, retries = 3 }) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "text/csv,*/*" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const text = await res.text();
      if (text.length < minLength || !text.toLowerCase().startsWith(headerPrefix))
        throw new Error("not a CSV / too small (" + text.length + " bytes)");
      return text;
    } catch (e) {
      lastErr = e;
      console.warn(`${url} attempt ${attempt} failed: ${e.message}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw lastErr;
}

// Today's date in IST (the Action runs on UTC machines)
function istDateParts() {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = ist.getUTCFullYear();
  return { dd, mm, yyyy };
}

const csvText = await fetchCsv(SOURCE_URL, { headerPrefix: "symbol", minLength: 10000 });
const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
const iSymbol = header.indexOf("symbol");
const iSeries = header.indexOf("series");
const iBand = header.indexOf("band");
if (iSymbol === -1 || iBand === -1) throw new Error("unexpected header: " + lines[0]);

const bands = {};
let count = 0;
for (const line of lines.slice(1)) {
  const f = parseCsvLine(line);
  const symbol = (f[iSymbol] || "").trim().toUpperCase();
  const series = (f[iSeries] || "").trim().toUpperCase();
  const raw = (f[iBand] || "").trim();
  if (!symbol) continue;

  const band = /^\d+$/.test(raw) ? parseInt(raw, 10) : "NB"; // "No Band" -> "NB"

  // A symbol can appear in multiple series; prefer the EQ row if we saw one already
  if (bands[symbol] !== undefined && series !== "EQ") continue;
  bands[symbol] = band;
  count++;
}

if (count < 500) throw new Error("only " + count + " rows parsed — refusing to overwrite");

// Overlay this evening's change file (bands effective from the next trade date).
// Missing file just means no changes published yet today (holiday/weekend/too early).
const { dd, mm, yyyy } = istDateParts();
const changesUrl = `${CHANGES_URL_BASE}${dd}${mm}${yyyy}.csv`;
let changesApplied = 0;
try {
  const changesCsv = await fetchCsv(changesUrl, {
    headerPrefix: "sr. no",
    minLength: 20,
    retries: 1,
  });
  const cLines = changesCsv.split(/\r?\n/).filter((l) => l.trim());
  const cHeader = parseCsvLine(cLines[0]).map((h) => h.trim().toLowerCase());
  const ciSymbol = cHeader.indexOf("symbol");
  const ciTo = cHeader.indexOf("to");
  if (ciSymbol === -1 || ciTo === -1) throw new Error("unexpected header: " + cLines[0]);
  for (const line of cLines.slice(1)) {
    const f = parseCsvLine(line);
    const symbol = (f[ciSymbol] || "").trim().toUpperCase();
    const to = (f[ciTo] || "").trim();
    if (!symbol || !/^\d+$/.test(to)) continue;
    bands[symbol] = parseInt(to, 10);
    changesApplied++;
  }
  console.log(`applied ${changesApplied} band changes from ${changesUrl}`);
} catch {
  console.log(`no change file for today (${changesUrl}) — using base list only`);
}

const out = {
  updated: new Date().toISOString().slice(0, 10),
  source: SOURCE_URL,
  count,
  changesApplied,
  bands,
};

// Skip the commit churn if nothing actually changed
if (existsSync(OUT_FILE)) {
  const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
  if (JSON.stringify(prev.bands) === JSON.stringify(bands)) {
    console.log("no changes in band data");
  }
}

writeFileSync(OUT_FILE, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT_FILE}: ${count} symbols, updated ${out.updated}`);
