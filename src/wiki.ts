/**
 * Live client for the community Palworld Wiki (https://palworld.wiki.gg), a
 * MediaWiki site. Unlike the shipped dataset this is always current: editors
 * update it as patches land, and it covers what the dataset does not - guides,
 * bosses, locations, structures, technology, mechanics and lore.
 *
 * Content is CC BY-SA; every result carries the page URL for attribution.
 */
import { fetchJson } from './fetch-json.js';
import { htmlToMarkdown, stripHtmlTags, truncateContent } from './markdown.js';

const WIKI_API = process.env.PALWORLD_WIKI_API ?? 'https://palworld.wiki.gg/api.php';
const WIKI_PAGE_BASE = process.env.PALWORLD_WIKI_PAGE_BASE ?? 'https://palworld.wiki.gg/wiki/';

export function wikiPageUrl(title: string): string {
  return WIKI_PAGE_BASE + encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':');
}

function apiUrl(params: Record<string, string | number>): string {
  const query = new URLSearchParams({ format: 'json', formatversion: '2' });
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `${WIKI_API}?${query.toString()}`;
}

interface ApiError {
  error?: { code: string; info: string };
}

export interface WikiSearchResult {
  title: string;
  snippet: string;
  url: string;
  lastEdited?: string;
}

export interface WikiSearchResponse {
  totalHits: number;
  results: WikiSearchResult[];
}

interface SearchApiResponse extends ApiError {
  query?: {
    searchinfo?: { totalhits?: number };
    search?: { title: string; snippet?: string; timestamp?: string }[];
  };
}

export async function wikiSearch(query: string, limit = 5): Promise<WikiSearchResponse> {
  const body = await fetchJson<SearchApiResponse>(
    apiUrl({ action: 'query', list: 'search', srsearch: query, srlimit: limit, srprop: 'snippet|timestamp', srinfo: 'totalhits' }),
  );
  if (body.error) throw new Error(`wiki search failed: ${body.error.info}`);
  const hits = body.query?.search ?? [];
  return {
    totalHits: body.query?.searchinfo?.totalhits ?? hits.length,
    results: hits.map((hit) => ({
      title: hit.title,
      snippet: stripHtmlTags(hit.snippet ?? ''),
      url: wikiPageUrl(hit.title),
      ...(hit.timestamp ? { lastEdited: hit.timestamp } : {}),
    })),
  };
}

interface ParseSection {
  index: string;
  line: string;
  level: string;
}

interface ParseApiResponse extends ApiError {
  parse?: { title: string; text?: string; sections?: ParseSection[] };
}

export class WikiPageNotFoundError extends Error {
  constructor(readonly title: string) {
    super(`no wiki page titled "${title}"`);
    this.name = 'WikiPageNotFoundError';
  }
}

export class WikiSectionNotFoundError extends Error {
  constructor(
    readonly section: string,
    readonly available: string[],
  ) {
    super(`no section "${section}"`);
    this.name = 'WikiSectionNotFoundError';
  }
}

export interface WikiPage {
  title: string;
  url: string;
  /** Top-level section headings of the whole page, for follow-up `section` calls. */
  sections: string[];
  /** Set when a single section was requested. */
  section?: string;
  content: string;
  truncated: boolean;
  originalLength: number;
}

const PARSE_OPTIONS = { redirects: 1, disableeditsection: 1, disablelimitreport: 1, disabletoc: 1 } as const;

const normalizeHeading = (text: string) => stripHtmlTags(text).toLowerCase();

async function parsePage(params: Record<string, string | number>, title: string): Promise<NonNullable<ParseApiResponse['parse']>> {
  const body = await fetchJson<ParseApiResponse>(apiUrl({ action: 'parse', page: title, ...PARSE_OPTIONS, ...params }));
  if (body.error) {
    if (body.error.code === 'missingtitle' || body.error.code === 'invalidtitle') throw new WikiPageNotFoundError(title);
    throw new Error(`wiki lookup failed: ${body.error.info}`);
  }
  if (!body.parse) throw new Error('wiki lookup failed: empty response');
  return body.parse;
}

export async function wikiGetPage(title: string, options: { section?: string; maxLength?: number } = {}): Promise<WikiPage> {
  const { section, maxLength = 8000 } = options;

  let parsed: NonNullable<ParseApiResponse['parse']>;
  let allSections: ParseSection[];
  let sectionTitle: string | undefined;

  if (section) {
    const outline = await parsePage({ prop: 'sections' }, title);
    allSections = outline.sections ?? [];
    const wanted = normalizeHeading(section);
    // Exact heading first, then a substring match ("drops" -> "Normal Drops").
    const match =
      allSections.find((s) => s.index && normalizeHeading(s.line) === wanted) ??
      allSections.find((s) => s.index && normalizeHeading(s.line).includes(wanted));
    if (!match) {
      throw new WikiSectionNotFoundError(
        section,
        allSections.map((s) => stripHtmlTags(s.line)),
      );
    }
    sectionTitle = stripHtmlTags(match.line);
    parsed = await parsePage({ prop: 'text', section: match.index }, outline.title);
  } else {
    parsed = await parsePage({ prop: 'text|sections' }, title);
    allSections = parsed.sections ?? [];
  }

  const markdown = htmlToMarkdown(parsed.text ?? '');
  const { content, truncated, originalLength } = truncateContent(markdown, maxLength);
  return {
    title: parsed.title,
    url: wikiPageUrl(parsed.title),
    sections: allSections.filter((s) => s.level === '2').map((s) => stripHtmlTags(s.line)),
    ...(sectionTitle ? { section: sectionTitle } : {}),
    content,
    truncated,
    originalLength,
  };
}
