import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";

const MAX_BYTES = 1_048_576;
/** Conservative IPv4-only source fetcher. IPv6 is unsupported, never guessed public. */
export function publicRecipeAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
type Page = { status: number; body: string; location?: string };
type FetchOptions = { signal?: AbortSignal; resolve?: (hostname: string) => Promise<string[]>; request?: (url: URL, address: string, signal: AbortSignal) => Promise<Page> };
function publicUrl(input: string): URL {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || (isIP(hostname) && !publicRecipeAddress(hostname))) throw new Error("Recipe source must use public HTTPS");
  return url;
}
function pinnedRequest(url: URL, address: string, signal: AbortSignal): Promise<Page> {
  return new Promise((resolve, reject) => {
    // Pin DNS result on the actual socket; TLS still verifies the URL hostname.
    const req = httpsRequest(url, { signal, agent: false, family: 4, lookup: (_host, _options, callback) => callback(null, address, 4), headers: { Accept: "text/html,application/xhtml+xml", "Accept-Encoding": "identity" } }, response => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) { response.destroy(); resolve({ status, body: "", location: response.headers.location }); return; }
      if (Number(response.headers["content-length"]) > MAX_BYTES || (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity")) { response.destroy(); reject(new Error("Recipe body too large or encoded")); return; }
      if (!String(response.headers["content-type"] ?? "").match(/^(text\/html|application\/xhtml\+xml)(;|$)/i)) { response.destroy(); reject(new Error("Recipe source must return HTML")); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) response.destroy(new Error("Recipe body too large")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end();
  });
}
export async function fetchRecipePage(input: string, options: FetchOptions = {}) {
  const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal ? [options.signal] : [])]);
  const resolve = options.resolve ?? (async hostname => (await lookup(hostname, { all: true, family: 4 })).map(r => r.address));
  const request = options.request ?? pinnedRequest;
  let url = publicUrl(input);
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal.throwIfAborted();
    const addresses = await new Promise<string[]>((done, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      resolve(url.hostname).then(done, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    if (!addresses.length || addresses.some(a => !publicRecipeAddress(a))) throw new Error("Recipe DNS target must be public");
    const page = await request(url, addresses[0], signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(page.body) > MAX_BYTES) throw new Error("Recipe body too large");
    if (page.status >= 300 && page.status < 400) { if (!page.location) throw new Error("Missing redirect target"); url = publicUrl(new URL(page.location, url).href); continue; }
    if (page.status !== 200) throw new Error("Recipe source unavailable");
    return { url: url.href, body: page.body };
  }
  throw new Error("Too many recipe redirects");
}
