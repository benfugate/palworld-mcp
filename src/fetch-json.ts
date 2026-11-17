/**
 * Small JSON-over-HTTP helper for the live tools: timeout, a descriptive
 * User-Agent (wiki.gg asks automated clients to identify themselves) and a
 * short in-memory cache so a chatty model does not re-fetch the same page.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_CACHE_ENTRIES = 200;

let userAgent = process.env.PALWORLD_MCP_USER_AGENT ?? 'palworld-mcp (+https://github.com/franshjy/palworld-mcp)';

/** Called once at startup so the default User-Agent carries the server version. */
export function setUserAgentVersion(version: string): void {
  if (!process.env.PALWORLD_MCP_USER_AGENT) {
    userAgent = `palworld-mcp/${version} (+https://github.com/franshjy/palworld-mcp)`;
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

export function clearFetchCache(): void {
  cache.clear();
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface FetchJsonOptions {
  ttlMs?: number;
  timeoutMs?: number;
}

export async function fetchJson<T>(url: string, options: FetchJsonOptions = {}): Promise<T> {
  const { ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.value as T;

  const host = new URL(url).host;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': userAgent, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = (error as Error).name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (error as Error).message;
    throw new UpstreamError(`request to ${host} failed: ${reason}`);
  }
  if (!response.ok) {
    throw new UpstreamError(`${host} answered HTTP ${response.status}`, response.status);
  }

  let value: T;
  try {
    value = (await response.json()) as T;
  } catch {
    throw new UpstreamError(`${host} did not return JSON`);
  }

  if (ttlMs > 0) {
    // Map iteration is insertion-ordered, so the first key is the oldest.
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
    cache.set(url, { expires: now + ttlMs, value });
  }
  return value;
}
