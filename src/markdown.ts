/**
 * HTML -> markdown conversion for Palworld Wiki (palworld.wiki.gg) content.
 *
 * MediaWiki's `action=parse` returns rendered HTML, which is large (a pal page
 * is ~90k characters) and mostly chrome: the prev/next pal banner, navboxes,
 * the table of contents, galleries and hundreds of inline icons. Converting to
 * markdown and dropping that chrome leaves a few thousand readable characters -
 * small enough for a local model's context window.
 *
 * Ported from https://github.com/benfugate/mcp-osrs (MIT), itself adapted from
 * https://github.com/OddLobster/osrs-wiki-mcp (MIT).
 */
import TurndownService from 'turndown';

/** The slice of the DOM node API the rules below use. */
interface RuleNode {
  nodeName: string;
  getAttribute?: (name: string) => string | null;
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });

turndown.remove(['script', 'style', 'nav', 'audio', 'video', 'figure', 'noscript']);

const hasClass = (node: RuleNode, pattern: RegExp): boolean => pattern.test(node.getAttribute?.('class') ?? '');

// Page chrome that carries no information once out of the browser: the
// prev/next pal banner, footer navboxes, edit links, the table of contents,
// image galleries, reference lists and maintenance notices.
//
// The pal infobox ("druid") renders every heading and value once per tab
// (Basics / Skills / Stats) and hides the empty copies with CSS, so those are
// dropped too, as are work suitabilities the pal does not have (level 0).
const CHROME =
  /\b(pal-nav-banner|navbox|navbar|mw-editsection|toc|gallery|mw-references-wrap|reference|noprint|ambox|mw-empty-elt|mw-collapsible-toggle|druid-toggleable-heading-empty|druid-toggleable-data-empty|druid-tabs|pal-work-zero|ext-datamaps-container)\b/;

turndown.addRule('removeChrome', {
  filter: (node) => {
    const n = node as unknown as RuleNode;
    return n.getAttribute?.('id') === 'toc' || hasClass(n, CHROME);
  },
  replacement: () => '',
});

// Images are dropped, except that an inline icon's alt text is kept when it is a
// real label ("Kindling", "Ground") rather than a file name - on pal pages the
// work suitabilities and skill elements are icons with no text beside them.
// The label is wrapped in markers so cleanMarkdown can drop it again where the
// same word follows as text anyway ("[Ground icon] Ground damage").
const ICON_OPEN = '\u27e6';
const ICON_CLOSE = '\u27e7';

turndown.addRule('images', {
  filter: (node) => {
    const n = node as unknown as RuleNode;
    return n.nodeName.toLowerCase() === 'img' || hasClass(n, /\bmw-file-description\b/);
  },
  replacement: (_content, node) => {
    const n = node as unknown as RuleNode;
    if (n.nodeName.toLowerCase() !== 'img') return '';
    const alt = (n.getAttribute?.('alt') ?? '').trim();
    const width = Number(n.getAttribute?.('width') ?? 0);
    const isLabel = alt.length > 0 && alt.length <= 30 && !/\.(png|jpe?g|gif|webp|svg)$/i.test(alt) && width > 0 && width <= 64;
    return isLabel ? `${ICON_OPEN}${alt}${ICON_CLOSE}` : '';
  },
});

// Infobox rows and skill rows are a label and a value in separate blocks; put
// each on one line ("Element Ground", "Lv 22 Spinning Roundhouse Ground 300").
turndown.addRule('skillLevel', {
  filter: (node) => hasClass(node as unknown as RuleNode, /\bpal-active-skill-lv\b/),
  replacement: (content) => `${content.trim()} `,
});
turndown.addRule('singleLineRows', {
  filter: (node) => {
    const n = node as unknown as RuleNode & { innerHTML?: string };
    if (hasClass(n, /\bpal-active-skill-row\b/)) return true;
    // The infobox row that holds the skill list stays multi-line: one skill each.
    return hasClass(n, /\b(druid-row|druid-grid-item)\b/) && !/pal-active-skill-row/.test(n.innerHTML ?? '');
  },
  replacement: (content) => {
    const line = content.replace(/\s*\n+\s*/g, ' ').trim();
    return line ? `\n\n${line}\n\n` : '';
  },
});

// Interactive map embeds are empty without JavaScript.
turndown.addRule('removeMaps', {
  filter: (node) =>
    node.nodeName.toLowerCase() === 'details' && /ext-datamaps|data-mw-datamaps/.test((node as unknown as { innerHTML?: string }).innerHTML ?? ''),
  replacement: () => '',
});

turndown.addRule('removeHidden', {
  filter: (node) => /display\s*:\s*none/i.test((node as unknown as RuleNode).getAttribute?.('style') ?? ''),
  replacement: () => '',
});

// Turndown has no table support of its own and would run every cell together.
// One row per line with " | " between cells is not strict GFM (no header rule),
// but it keeps drop tables and stat tables readable.
turndown.addRule('tableCell', {
  filter: ['th', 'td'],
  replacement: (content) => ` ${content.replace(/\s*\n+\s*/g, ' ').trim()} |`,
});
turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content) => (content.replace(/[\s|]/g, '') ? `\n|${content}` : ''),
});
turndown.addRule('table', {
  filter: ['table', 'thead', 'tbody', 'tfoot', 'caption'],
  replacement: (content, node) =>
    (node as unknown as RuleNode).nodeName.toLowerCase() === 'table' ? `\n\n${content.trim()}\n\n` : content,
});

function findClosing(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inQuote = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    // Link titles ("...") may contain unbalanced parentheses.
    if (open === '(' && ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Strips markdown links down to their text, dropping images entirely. Written
 * by hand rather than with a regex because wiki URLs contain nested parentheses
 * (e.g. `/wiki/Sphere_(Item)`) that a naive `\(...\)` match truncates.
 */
export function stripMarkdownLinks(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const isImage = text[i] === '!' && text[i + 1] === '[';
    if (isImage || text[i] === '[') {
      const openBracket = isImage ? i + 1 : i;
      const closeBracket = findClosing(text, openBracket, '[', ']');
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = findClosing(text, closeBracket + 1, '(', ')');
        if (closeParen !== -1) {
          const linkText = text.slice(openBracket + 1, closeBracket);
          // Images, and links that only wrap an image, contribute nothing readable.
          if (!isImage && !/^!\[/.test(linkText)) out.push(linkText);
          i = closeParen + 1;
          continue;
        }
      }
    }
    out.push(text[i]!);
    i++;
  }
  return out.join('');
}

/** Drops a paragraph that only repeats the one before it. */
function dropRepeatedParagraphs(md: string): string {
  const out: string[] = [];
  for (const paragraph of md.split(/\n{2,}/)) {
    if (paragraph.trim() && paragraph.trim() === out[out.length - 1]?.trim()) continue;
    out.push(paragraph);
  }
  return out.join('\n\n');
}

const ICON_LABEL = new RegExp(`${ICON_OPEN}([^${ICON_CLOSE}]*)${ICON_CLOSE}`, 'g');

/** Icon label -> plain text, unless the same text already follows it. */
function resolveIconLabels(md: string): string {
  return md.replace(ICON_LABEL, (_match, label: string, offset: number, whole: string) => {
    const rest = whole.slice(offset + label.length + 2).replace(/^[\s\u00a0]+/, '');
    return rest.toLowerCase().startsWith(label.toLowerCase()) ? '' : `${label} `;
  });
}

export function cleanMarkdown(md: string): string {
  return dropRepeatedParagraphs(
    resolveIconLabels(stripMarkdownLinks(md))
      .replace(/\\?\[edit[^\]]*\]/g, '')
      .replace(/\\\[\d+\\\]/g, '') // footnote markers
      .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?\\-]|$)/gm, '$1$2')
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|=])/g, '$1') // turndown's markdown escapes
      .replace(/\[\s*\]/g, '')
      .replace(/^\|(\s*\|)+\s*$/gm, '') // table rows left empty once icons are gone
      .replace(/\u00a0/g, ' ')
      .replace(/(\S)[ \t]{2,}/g, '$1 ') // gaps left where inline icons were removed
      .replace(/^[ \t]+(?=\S)/gm, '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

/** Converts a wiki HTML fragment to clean markdown. */
export function htmlToMarkdown(html: string): string {
  return cleanMarkdown(turndown.turndown(html));
}

const ENTITIES: Record<string, string> = { quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * Strips HTML from wiki search snippets, which come back with
 * `<span class="searchmatch">` highlighting around every matched term.
 */
export function stripHtmlTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  originalLength: number;
}

/**
 * Caps content length, cutting at a heading or paragraph boundary where
 * possible so the result does not end mid-sentence.
 */
export function truncateContent(content: string, maxLength: number): TruncateResult {
  const originalLength = content.length;
  if (originalLength <= maxLength) return { content, truncated: false, originalLength };

  const window = content.slice(0, maxLength);
  let cut = window.lastIndexOf('\n#');
  if (cut < maxLength * 0.5) cut = window.lastIndexOf('\n\n');
  if (cut < maxLength * 0.5) cut = window.lastIndexOf('\n');
  if (cut < maxLength * 0.5) cut = window.lastIndexOf('. ') + 1;
  if (cut < maxLength * 0.5) cut = maxLength;

  return { content: content.slice(0, cut).trimEnd(), truncated: true, originalLength };
}
