/**
 * Official weekly admissions from the Czech film distributors' association.
 *
 * UFD publishes a top 20 every Monday covering the weekend just gone, as an
 * .xls attached to a monthly article. Unlike our scraping this is *national* —
 * every cinema, not just the chains we can reach — and it is the number the
 * industry actually quotes. It is also a week old by the time it appears, which
 * is exactly the gap the live scraping fills.
 *
 * Each row carries both the weekend and the running total for the film's whole
 * release, so one file gives us a point in a weekly series and a cumulative
 * figure at the same time.
 */

import { fetchText } from "@/lib/http";
import { readXls, type Cell } from "@/lib/xls";

const BASE = "https://www.ufd.cz";
const INDEX = `${BASE}/top-20-filmu/top-20-cr`;

export type UfdRow = {
  rank: number;
  title: string;
  distributor: string;
  country: string;
  /** Weeks in release at the time of this report. */
  weekOfRun: number;
  cinemas: number;
  weekendGross: number;
  weekendAdmissions: number;
  totalGross: number;
  totalAdmissions: number;
};

export type UfdWeek = {
  year: number;
  week: number;
  /** `YYYY-MM-DD` — the Thursday the weekend opened on. */
  weekendFrom: string;
  rows: UfdRow[];
};

/** `top20-2026-30cz.xls` → year 2026, week 30. */
export function parseFileName(url: string): { year: number; week: number } | null {
  const m = url.match(/top20-(\d{4})-(\d{1,2})cz\.xlsx?$/i);
  return m ? { year: Number(m[1]), week: Number(m[2]) } : null;
}

/** Monthly article URLs, newest first. UFD paginates them ten to a page. */
export async function fetchArticleUrls(maxPages = 30): Promise<string[]> {
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const html = await fetchText(page === 0 ? INDEX : `${INDEX}?page=${page}`, {
      timeoutMs: 25_000,
    });
    const found = new Set(html.match(/\/top-20-cr-[a-z0-9-]+/gi) ?? []);
    // A page that adds nothing new means we have reached the end of the archive.
    const before = seen.size;
    for (const href of found) seen.add(href);
    if (seen.size === before) break;
  }
  return [...seen];
}

/** The weekly spreadsheets linked from one monthly article. */
export async function fetchWeekFileUrls(articlePath: string): Promise<string[]> {
  const html = await fetchText(`${BASE}${articlePath}`, { timeoutMs: 25_000 });
  const links = html.match(/https?:\/\/[^"']*top20-\d{4}-\d{1,2}cz\.xlsx?/gi) ?? [];
  return [...new Set(links)];
}

const text = (c: Cell): string => (typeof c === "string" ? c.trim() : c === null ? "" : String(c));
const number = (c: Cell): number => {
  if (typeof c === "number") return c;
  // A few older files store figures as text with spaces as thousand separators.
  const cleaned = text(c).replace(/[\s ]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

/** `Víkend od: 23.07.2026` → `2026-07-23`. */
function parseWeekendFrom(header: string): string | null {
  const m = header.match(/V[íi]kend od:\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/i);
  if (!m) return null;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/**
 * Columns are located by their header text rather than by position, so a future
 * file that gains a column does not silently shift every number one to the left.
 */
function findColumns(sheet: Cell[][]): { headerRow: number; cols: Record<string, number> } | null {
  for (let row = 0; row < Math.min(sheet.length, 12); row++) {
    const cells = sheet[row].map(text);
    if (cells[2] !== "Film") continue;

    const cols: Record<string, number> = { rank: 0, title: 2, distributor: 3, country: 4 };
    // The header spans two rows: "Víkend" over "tržby" / "diváci".
    const below = (sheet[row + 1] ?? []).map(text);
    for (let c = 0; c < cells.length; c++) {
      const top = cells[c];
      const sub = below[c] ?? "";
      if (top === "Poč" && sub.startsWith("týd")) cols.weekOfRun = c;
      else if (top === "Poč." && sub === "kin" && cols.cinemas === undefined) cols.cinemas = c;
      else if (top === "Víkend" && sub === "tržby") cols.weekendGross = c;
      else if (top === "Víkend" && sub === "diváci") cols.weekendAdmissions = c;
      else if (top === "Celkem" && sub === "tržby") cols.totalGross = c;
      else if (top === "Celkem" && sub === "diváci") cols.totalAdmissions = c;
    }
    if (cols.weekendAdmissions === undefined || cols.totalAdmissions === undefined) return null;
    return { headerRow: row, cols };
  }
  return null;
}

export function parseWeek(sheet: Cell[][], fallback: { year: number; week: number }): UfdWeek {
  const header = sheet.slice(0, 6).map((r) => text(r[0])).join(" ");
  const located = findColumns(sheet);
  if (!located) throw new Error("UFD sheet has no recognisable header row");

  const { headerRow, cols } = located;
  const rows: UfdRow[] = [];

  for (let r = headerRow + 2; r < sheet.length; r++) {
    const line = sheet[r];
    const title = text(line[cols.title]);
    const rank = number(line[cols.rank]);
    // The table ends with copyright and note lines that have no rank.
    if (!title || !rank) continue;

    rows.push({
      rank,
      title,
      distributor: text(line[cols.distributor]),
      country: text(line[cols.country]),
      weekOfRun: cols.weekOfRun !== undefined ? number(line[cols.weekOfRun]) : 0,
      cinemas: cols.cinemas !== undefined ? number(line[cols.cinemas]) : 0,
      weekendGross: number(line[cols.weekendGross]),
      weekendAdmissions: number(line[cols.weekendAdmissions]),
      totalGross: number(line[cols.totalGross]),
      totalAdmissions: number(line[cols.totalAdmissions]),
    });
  }

  return {
    year: fallback.year,
    week: fallback.week,
    weekendFrom: parseWeekendFrom(header) ?? "",
    rows,
  };
}

// ---------------------------------------------------------------------------
// Annual top 50
// ---------------------------------------------------------------------------

/**
 * UFD also publishes a top 50 for each finished year, and those files carry a
 * second block of columns headed "Hodnoty od premiéry" — the film's totals for
 * its whole life, not just the calendar year.
 *
 * That matters because the weekly tables only ever show the top 20. A film that
 * slips out of the ranking while still playing simply stops being reported, so
 * the largest weekly figure understates its real run — measured against the
 * 2024 annual list, by up to 14% for mid-table films. The annual files close
 * that gap and reach back to 2017, further than the weeklies we hold.
 */
const ANNUAL_INDEX = `${BASE}/prehledy-statistiky/top-50-rocni-vysledky`;

export type UfdAnnualRow = {
  rank: number;
  title: string;
  originalTitle: string;
  distributor: string;
  country: string;
  /** `YYYY-MM-DD`, converted from the sheet's serial date. */
  premiere: string | null;
  screenings: number;
  admissions: number;
  gross: number;
};

export type UfdAnnual = { year: number; rows: UfdAnnualRow[] };

export function parseAnnualFileName(url: string): number | null {
  const m = url.match(/top50(\d{4})\.xlsx?$/i);
  return m ? Number(m[1]) : null;
}

export async function fetchAnnualFileUrls(): Promise<string[]> {
  const html = await fetchText(ANNUAL_INDEX, { timeoutMs: 25_000 });
  return [...new Set(html.match(/https?:\/\/[^"']*top50\d{4}\.xlsx?/gi) ?? [])];
}

/** Excel stores dates as days since 1899-12-30. */
function excelDate(value: Cell): string | null {
  if (typeof value !== "number" || value < 20000 || value > 60000) return null;
  return new Date(Date.UTC(1899, 11, 30) + value * 86_400_000).toISOString().slice(0, 10);
}

export function parseAnnual(sheet: Cell[][], year: number): UfdAnnual {
  const headerRow = sheet.findIndex((r) => text(r[0]) === "Poř." && text(r[1]) === "Titul");
  if (headerRow < 0) throw new Error("UFD annual sheet has no recognisable header row");

  // The lifetime block starts at the column the "Hodnoty od premiéry" caption
  // sits above; falling back to the fixed layout would silently read the
  // calendar-year figures instead, which is the whole thing we are avoiding.
  const captionRow = sheet.slice(0, headerRow).find((r) => r.some((c) => /od prem/i.test(text(c))));
  const lifetimeAt = captionRow?.findIndex((c) => /od prem/i.test(text(c))) ?? -1;
  if (lifetimeAt < 0) throw new Error("UFD annual sheet has no lifetime columns");

  const rows: UfdAnnualRow[] = [];
  for (const line of sheet.slice(headerRow + 1)) {
    const rank = number(line[0]);
    const title = text(line[1]);
    if (!rank || !title) continue;
    rows.push({
      rank,
      title,
      originalTitle: text(line[2]),
      distributor: text(line[3]),
      country: text(line[6]),
      premiere: excelDate(line[5]),
      screenings: number(line[lifetimeAt]),
      admissions: number(line[lifetimeAt + 1]),
      gross: number(line[lifetimeAt + 2]),
    });
  }
  return { year, rows };
}

export async function fetchAnnual(fileUrl: string): Promise<UfdAnnual> {
  const year = parseAnnualFileName(fileUrl);
  if (!year) throw new Error(`unrecognised UFD annual file name: ${fileUrl}`);
  return parseAnnual(readXls(await download(fileUrl)), year);
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { "user-agent": process.env.SCRAPER_CONTACT ?? "CineScrapeBot/0.1" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function fetchWeek(fileUrl: string): Promise<UfdWeek> {
  const named = parseFileName(fileUrl);
  if (!named) throw new Error(`unrecognised UFD file name: ${fileUrl}`);

  return parseWeek(readXls(await download(fileUrl)), named);
}
