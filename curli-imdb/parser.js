// parser.js
//
// curli "https://www.imdb.com/chart/tvmeter/?ref_=chtmvm_nv_menu" | DEBUG=curli node parser.js
//
// Works in:
// 1) VPS (Node 18+) via CLI:
//    curl https://example.com | node parser.js
//    curli "https://www.imdb.com/chart/tvmeter/?ref_=chtmvm_nv_menu" | node parser.js
//
// 2) Cloudflare Worker:
//    # local dev
//    wrangler dev
//
//    # deploy
//    wrangler deploy
//
//    # test
//    curl -X POST http://127.0.0.1:8787 --data-binary @page.html

// Use worker-optimized build
import { parseHTML } from "linkedom/worker";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { DEFAULT_SITE_INTERVAL_MS, SITE_INTERVAL_MS } from "./config.js";

const DEBUG_ENABLED = process.env.DEBUG?.split(',').some(v => v === 'curli' || v === '*');
const debug = (msg) => {
  if (DEBUG_ENABLED) {
    console.debug(`[curli] ${msg}`);
  }
};

let curliQueue = Promise.resolve();
let lastCurliRequestAt = null;

async function scheduleCurliRequest(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

  const task = curliQueue.then(async () => {
    let waitMs = 0;
    if (lastCurliRequestAt !== null) {
      const now = performance.now();
      waitMs = Math.max(0, lastCurliRequestAt + intervalMs - now);
      if (waitMs > 0) {
        await setTimeout(waitMs);
      }
    }
    lastCurliRequestAt = performance.now();
  });

  curliQueue = task.catch(() => {});
  await task;
}

async function fetchHtmlWithCurli(url) {
  const hostname = new URL(url).hostname;
  const intervalMs = SITE_INTERVAL_MS[hostname] ?? DEFAULT_SITE_INTERVAL_MS;
  debug(`host=${hostname} interval=${intervalMs}ms`);
  await scheduleCurliRequest(intervalMs);
  debug(`exec=${url}`);

  const marker = "__HTTP_STATUS_CODE__:";
  const output = await x("curli", ["-L", "-sS", "-o", "-", "-w", `\\n${marker}%{http_code}`, url], {
    throwOnError: false
  });

  if (output.exitCode !== 0) {
    throw new Error(`HTTP fetch command exited with code ${output.exitCode}`);
  }

  const rawStdout = output.stdout ?? "";
  const markerIndex = rawStdout.lastIndexOf(marker);
  if (markerIndex === -1) {
    throw new Error("Unable to determine HTTP status code from curli output");
  }

  const body = rawStdout.slice(0, markerIndex).trim();
  const statusText = rawStdout.slice(markerIndex + marker.length).trim();
  const statusCode = Number.parseInt(statusText, 10);
  if (!Number.isInteger(statusCode)) {
    throw new Error(`Invalid HTTP status code: ${statusText}`);
  }

  debug(`code=${statusCode}`);
  if (statusCode !== 200) {
    throw new Error(`HTTP status ${statusCode}`);
  }
  if (!body) {
    throw new Error("Empty response body");
  }

  return body;
}

function parseOpenGraph(html) {
  const { document } = parseHTML(html);
  const openGraph = {};

  for (const meta of document.querySelectorAll('meta[property^="og:"]')) {
    const property = meta.getAttribute("property")?.trim();
    const content = meta.getAttribute("content")?.trim();
    if (!property || !content) continue;
    openGraph[property] = content;
  }

  return openGraph;
}

/* ======================
   HTML → JSON
====================== */
export async function htmlToJSON(html, options = {}) {
  const fetchPage = options.fetchPage ?? fetchHtmlWithCurli;
  const { document } = parseHTML(html);
  const imdbBaseUrl = "https://www.imdb.com";
  const list = [];

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const docs = Array.isArray(parsed) ? parsed : [parsed];

    for (const doc of docs) {
      if (doc?.["@type"] !== "ItemList" || !Array.isArray(doc.itemListElement)) {
        continue;
      }

      for (const entry of doc.itemListElement) {
        const title = entry?.item?.name?.trim();
        const rawUrl = entry?.item?.url?.trim();
        if (!title || !rawUrl) continue;

        try {
          list.push({
            title,
            url: new URL(rawUrl, imdbBaseUrl).toString()
          });
        } catch {
          // Ignore malformed URLs.
        }
      }
    }
  }

  const details = await Promise.all(
    list.map(async item => {
      try {
        const detailHtml = await fetchPage(item.url);
        return {
          ...item,
          openGraph: parseOpenGraph(detailHtml)
        };
      } catch (error) {
        return {
          ...item,
          error: error instanceof Error ? error.message : String(error),
          openGraph: {}
        };
      }
    })
  );

  return {
    list,
    details,
    length: list.length
  };
}

/* ======================
   Main Handler
====================== */
export async function handle(input) {
  const trimmed = input.trim();

  // JSON input
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return {
        parsed: JSON.parse(trimmed)
      };
    } catch {
      return { error: "invalid json" };
    }
  }

  // HTML input
  return htmlToJSON(trimmed);
}

/* ======================
   VPS CLI Mode
====================== */
const isCliMode =
  typeof process !== "undefined" &&
  !!process.stdin &&
  !!process.argv?.[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCliMode) {
  let buffer = "";

  process.stdin.on("data", chunk => {
    buffer += chunk;
  });

  process.stdin.on("end", async () => {
    const result = await handle(buffer);
    console.log(JSON.stringify(result, null, 2));
  });
}

/* ======================
   Cloudflare Worker Mode
====================== */
export default {
  async fetch(request) {
    const text = await request.text();
    const result = await handle(text);

    return new Response(JSON.stringify(result), {
      headers: { "content-type": "application/json" }
    });
  }
};
