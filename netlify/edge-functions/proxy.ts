import type { Config, Context } from "@netlify/edge-functions";

const TARGET = "https://lunaar.org";
const FALLBACK_HEADER = "x-lunaar-fallback";

// The in-site web proxy (Ultraviolet/Scramjet) tunnels every page it loads through a
// WebSocket at `<this host>/wisp/`. Edge functions can't relay WebSockets, so point
// those scripts straight at lunaar.org's wisp server instead.
const WISP_HOST_PATTERN = /location\.host\s*\+\s*(["'`])\/wisp\//g;
const WISP_HOST_REPLACEMENT = `"${new URL(TARGET).host}" + $1/wisp/`;

// Headers that must not be copied between the client and the upstream request.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
];

async function serveFallback(req: Request, errorMessage: string) {
  try {
    // Internal request for static/index.html; the header lets it bypass this function.
    const page = await fetch(new URL("/index.html", req.url), {
      headers: { [FALLBACK_HEADER]: "1" },
    });
    const html = (await page.text()).replace("{{ERROR_MESSAGE}}", errorMessage);
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  } catch {
    return new Response(`<h1>Error</h1><p>${errorMessage}</p>`, {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}

export default async (req: Request, _context: Context) => {
  if (req.headers.get(FALLBACK_HEADER)) return;

  const url = new URL(req.url);
  const targetUrl = new URL(url.pathname + url.search, TARGET);

  const headers = new Headers(req.headers);
  for (const h of HOP_BY_HOP) headers.delete(h);
  headers.set("origin", TARGET);
  headers.delete("referer");

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
      redirect: "manual",
    });
  } catch (err) {
    console.error("Target unreachable:", (err as Error).message);
    return serveFallback(req, (err as Error).message);
  }

  const resHeaders = new Headers(upstream.headers);
  // fetch already decoded the body, so the original encoding/length no longer apply.
  resHeaders.delete("content-encoding");
  resHeaders.delete("content-length");

  // Keep upstream redirects on this site instead of sending visitors to lunaar.org.
  const location = resHeaders.get("location");
  if (location) {
    const loc = new URL(location, TARGET);
    if (loc.origin === TARGET) {
      resHeaders.set("location", loc.pathname + loc.search + loc.hash);
    }
  }

  // Cookies scoped to lunaar.org would be rejected by the browser on this domain.
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) {
    resHeaders.delete("set-cookie");
    for (const c of cookies) {
      resHeaders.append("set-cookie", c.replace(/;\s*domain=[^;]*/i, ""));
    }
  }

  const contentType = resHeaders.get("content-type") ?? "";
  if (/javascript|html/.test(contentType)) {
    const text = (await upstream.text()).replace(WISP_HOST_PATTERN, WISP_HOST_REPLACEMENT);
    return new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: resHeaders,
  });
};

export const config: Config = {
  path: "/*",
};
