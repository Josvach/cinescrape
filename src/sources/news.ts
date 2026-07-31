/**
 * Articles and reviews about a film, from Google News' RSS search.
 *
 * Deliberately not scraped from ČSFD or Kinobox. Both run active anti-bot
 * challenges — ČSFD answers with a proof-of-work interstitial, Kinobox with a
 * Cloudflare block — and getting around those means defeating an access control
 * the site owner put there on purpose. Google News indexes both anyway, so
 * their reviews still surface here as links, which is the way the publishers
 * intended them to be read.
 *
 * The feed needs no key and no account.
 */

import { fetchText } from "@/lib/http";

const FEED = "https://news.google.com/rss/search";

export type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  /** Set when the headline reads like a review rather than reporting. */
  isReview: boolean;
};

const REVIEW_MARKERS = /\b(recenze|kritika|hodnocen[íi]|dojmy)\b/i;

/**
 * Google News encodes Czech diacritics as numeric entities, so a headline
 * arrives as "Odyssea d&#225;l v&#225;lcuje" and would otherwise be displayed
 * verbatim. `&amp;` is unescaped last so that an already-escaped ampersand
 * cannot resurrect a second entity.
 */
function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

const tag = (xml: string, name: string): string => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]).trim() : "";
};

export function parseFeed(xml: string): Article[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const out: Article[] = [];

  for (const item of items) {
    const rawTitle = tag(item, "title");
    const url = tag(item, "link");
    if (!rawTitle || !url) continue;

    // Google appends " - Source" to every headline; splitting it off gives us
    // the publisher without a second request.
    const split = rawTitle.lastIndexOf(" - ");
    const title = split > 20 ? rawTitle.slice(0, split) : rawTitle;
    const source = tag(item, "source") || (split > 20 ? rawTitle.slice(split + 3) : "");

    const published = tag(item, "pubDate");
    const publishedAt = published ? new Date(published) : null;

    out.push({
      title,
      url,
      source,
      publishedAt:
        publishedAt && !Number.isNaN(publishedAt.getTime())
          ? publishedAt.toISOString()
          : new Date().toISOString(),
      isReview: REVIEW_MARKERS.test(title),
    });
  }
  return out;
}

/**
 * Czech-language coverage of one film.
 *
 * The title is quoted and paired with "film" so that a generic name like
 * "Odyssea" returns cinema coverage rather than everything that shares the word.
 */
export async function fetchArticles(title: string, limit = 8): Promise<Article[]> {
  const query = encodeURIComponent(`"${title}" film OR recenze`);
  const xml = await fetchText(`${FEED}?q=${query}&hl=cs&gl=CZ&ceid=CZ:cs`, { timeoutMs: 20_000 });

  const seen = new Set<string>();
  return parseFeed(xml)
    .filter((a) => {
      // Google syndicates the same story across aggregators; one per headline.
      const key = a.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}
