/**
 * Official Palworld announcements and patch notes, read from Steam's public
 * news feed for the game (no API key). Restricted to the developer's own
 * "Community Announcements" feed - the unfiltered feed is mostly third-party
 * press coverage in several languages.
 */
import { fetchJson } from './fetch-json.js';
import { decodeEntities, truncateContent } from './markdown.js';

export const PALWORLD_STEAM_APP_ID = 1623730;
const STEAM_NEWS_API = process.env.PALWORLD_STEAM_NEWS_API ?? 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/';
/** How far back a title query can reach. */
const FETCH_COUNT = 60;

interface SteamNewsItem {
  gid: string;
  title: string;
  url: string;
  contents: string;
  date: number;
  feedlabel?: string;
}

interface SteamNewsResponse {
  appnews?: { newsitems?: SteamNewsItem[] };
}

export interface NewsItem {
  title: string;
  date: string;
  url: string;
  content: string;
  truncated: boolean;
  originalLength: number;
}

// Formatting tags Steam announcements use. Matched by name so that literal
// bracketed text in patch notes ("[Major Bug Fixes]") survives.
const FORMAT_TAGS = /\[\/?(?:p|b|i|u|strike|list|olist|code|quote|table|tr|th|td|spoiler|noparse|c|carousel|expand)(?:=[^\]]*)?\]/gi;

/** Steam announcement markup (BBCode) -> plain markdown-ish text. */
export function steamMarkupToText(markup: string): string {
  return decodeEntities(
    markup
      .replace(/\r\n?/g, '\n')
      .replace(/\[img[^\]]*\][\s\S]*?\[\/img\]/gi, '')
      .replace(/\[previewyoutube[^\]]*\][\s\S]*?\[\/previewyoutube\]/gi, '')
      .replace(/\[dynamiclink\s+href="([^"]*)"\]\s*\[\/dynamiclink\]/gi, '$1')
      .replace(/\[url=(?:"([^"\]]*)"|([^\]\s]*))[^\]]*\]([\s\S]*?)\[\/url\]/gi, (_m, quoted: string, bare: string, text: string) => {
        const href = quoted ?? bare ?? '';
        const label = text.trim();
        return !label || label === href ? href : `${label} (${href})`;
      })
      .replace(/\[h([1-6])\]([\s\S]*?)\[\/h\1\]/gi, (_m, level: string, text: string) => `\n\n${'#'.repeat(Number(level) + 1)} ${text.trim()}\n\n`)
      .replace(/\[hr\]\s*(?:\[\/hr\])?/gi, '\n\n')
      .replace(/\[\*\]/g, '\n- ')
      .replace(/\[\/\*\]/g, '')
      .replace(/\[\/p\]/gi, '\n\n')
      .replace(/\[\/?(?:list|olist)\]/gi, '\n\n')
      .replace(FORMAT_TAGS, '')
      .replace(/\{STEAM_CLAN_IMAGE\}\S*/g, ''),
  )
    .replace(/\\([[\]])/g, '$1') // Steam escapes literal brackets
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n- \n+/g, '\n- ')
    // Items written as [*][p]...[/p][/*] would otherwise be a blank line apart.
    .replace(/^(- .*)\n{2,}(?=- )/gm, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NewsQuery {
  /** Case-insensitive substring of the announcement title, e.g. "v1.0" or "patch". */
  query?: string;
  limit?: number;
  /** Per-item cap on body length. */
  maxLength?: number;
}

export async function getGameNews({ query, limit = 5, maxLength = 1500 }: NewsQuery = {}): Promise<{ totalMatching: number; items: NewsItem[] }> {
  const params = new URLSearchParams({
    appid: String(PALWORLD_STEAM_APP_ID),
    count: String(FETCH_COUNT),
    maxlength: '0',
    feeds: 'steam_community_announcements',
    format: 'json',
  });
  const body = await fetchJson<SteamNewsResponse>(`${STEAM_NEWS_API}?${params.toString()}`);
  const all = body.appnews?.newsitems ?? [];
  const needle = query?.trim().toLowerCase();
  const matching = needle ? all.filter((item) => item.title.toLowerCase().includes(needle)) : all;

  return {
    totalMatching: matching.length,
    items: matching.slice(0, limit).map((item) => {
      const { content, truncated, originalLength } = truncateContent(steamMarkupToText(item.contents), maxLength);
      return {
        title: item.title,
        date: new Date(item.date * 1000).toISOString().slice(0, 10),
        url: item.url,
        content,
        truncated,
        originalLength,
      };
    }),
  };
}
