import { describe, expect, it } from "vitest";

import { parseFeed } from "./news";

/** Shaped exactly like a real Google News response, including its quirks. */
const feed = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Zprávy Google</title>
<item>
  <title>Recenze: Odyssea je Nolanův emočně nejfunkčnější film - Novinky.cz</title>
  <link>https://example.com/a</link>
  <pubDate>Thu, 16 Jul 2026 06:00:00 GMT</pubDate>
  <source url="https://novinky.cz">Novinky.cz</source>
</item>
<item>
  <title>Odyssea d&#225;l v&#225;lcuje &#269;esk&#225; kina - Moviezone.cz</title>
  <link>https://example.com/b</link>
  <pubDate>Wed, 15 Jul 2026 10:30:00 GMT</pubDate>
  <source url="https://moviezone.cz">Moviezone.cz</source>
</item>
<item>
  <title><![CDATA[Kritika filmu & jeho překladu]]></title>
  <link>https://example.com/c</link>
  <pubDate>Tue, 14 Jul 2026 08:00:00 GMT</pubDate>
</item>
</channel></rss>`;

describe("parseFeed", () => {
  it("reads headline, link, source and date", () => {
    const [first] = parseFeed(feed);
    expect(first.title).toBe("Recenze: Odyssea je Nolanův emočně nejfunkčnější film");
    expect(first.url).toBe("https://example.com/a");
    expect(first.source).toBe("Novinky.cz");
    expect(first.publishedAt).toBe("2026-07-16T06:00:00.000Z");
  });

  it("strips the publisher Google appends to every headline", () => {
    const titles = parseFeed(feed).map((a) => a.title);
    expect(titles.every((t) => !t.endsWith(".cz"))).toBe(true);
  });

  it("decodes entities and CDATA", () => {
    const items = parseFeed(feed);
    expect(items[1].title).toBe("Odyssea dál válcuje česká kina");
    expect(items[2].title).toBe("Kritika filmu & jeho překladu");
  });

  it("flags reviews so they can be surfaced first", () => {
    const items = parseFeed(feed);
    expect(items[0].isReview).toBe(true); // "Recenze:"
    expect(items[1].isReview).toBe(false);
    expect(items[2].isReview).toBe(true); // "Kritika"
  });

  it("survives an empty or broken feed", () => {
    expect(parseFeed("")).toEqual([]);
    expect(parseFeed("<rss><channel></channel></rss>")).toEqual([]);
  });

  it("skips items missing a headline or a link", () => {
    expect(parseFeed("<item><title>bez odkazu</title></item>")).toEqual([]);
  });
});
