/**
 * Local preview: serves site/ with data/ mounted underneath it, which is the
 * same layout GitHub Pages ends up with. Node's own http module, no deps.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT ?? 4000);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function resolve(urlPath) {
  // Strip the query, drop the leading slash so paths stay relative to the repo
  // rather than the filesystem root, and refuse to climb out.
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0]))
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.[/\\])+/, "");
  const candidates = clean === "" ? ["site/index.html"] : [join("site", clean), clean];
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

createServer(async (req, res) => {
  const path = await resolve(req.url ?? "/");
  if (!path) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
