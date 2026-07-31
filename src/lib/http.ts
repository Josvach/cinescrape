/**
 * Shared HTTP behaviour for the scrapers.
 *
 * We identify ourselves honestly and keep the request rate low. Both chains
 * allow generic crawlers in robots.txt, and staying polite is what keeps that
 * true — this fetches a few hundred small JSON documents an hour, not a flood.
 */

const DEFAULT_TIMEOUT_MS = 20_000;

export function userAgent(): string {
  const contact = process.env.SCRAPER_CONTACT?.trim();
  return contact ? `CineScrapeBot/0.1 ${contact}` : "CineScrapeBot/0.1";
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message?: string,
  ) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": userAgent(),
        ...rest.headers,
      },
      cache: "no-store",
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchText(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      headers: { "user-agent": userAgent(), ...rest.headers },
      cache: "no-store",
    });
    if (!res.ok) throw new HttpError(res.status, url);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs tasks one at a time with a minimum gap between starts, stopping early
 * once the caller's time budget is spent. Cron functions have a hard ceiling,
 * so the poller has to yield mid-queue rather than run to completion.
 */
export async function rateLimited<T, R>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  opts: { minIntervalMs: number; deadline: number; onError?: (item: T, err: unknown) => void },
): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    if (Date.now() >= opts.deadline) break;
    const startedAt = Date.now();
    try {
      results.push(await worker(item));
    } catch (err) {
      opts.onError?.(item, err);
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed < opts.minIntervalMs) await sleep(opts.minIntervalMs - elapsed);
  }
  return results;
}
