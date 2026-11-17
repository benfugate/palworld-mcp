/**
 * Live (network) tools: the Palworld Wiki and official news / patch notes.
 *
 * The dataset tools in index.ts answer from a snapshot built at a specific game
 * version. These answer from the live web, so they stay current between dataset
 * refreshes and cover topics the dataset has no table for.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { setUserAgentVersion } from './fetch-json.js';
import { getGameNews } from './news.js';
import { wikiGetPage, wikiSearch, WikiPageNotFoundError, WikiSectionNotFoundError } from './wiki.js';

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

export interface LiveToolsContext {
  version: string;
  /** Game version the offline dataset was built from, quoted in tool descriptions. */
  datasetGameVersion: string;
}

export function registerLiveTools(server: McpServer, context: LiveToolsContext): void {
  setUserAgentVersion(context.version);
  const snapshot = `the offline dataset behind get_pal/get_item/search_* (built at game v${context.datasetGameVersion})`;

  server.registerTool(
    'wiki_search',
    {
      title: 'Search the Palworld Wiki',
      description:
        `Live full-text search of the community Palworld Wiki (palworld.wiki.gg). Use it for anything that is not a pal/item stat or a breeding calculation - bosses and raids, locations, structures, technology, game mechanics, quests, lore, guides - and for content newer than ${snapshot}. Returns page titles with a short snippet; pass a title to wiki_get_page to read it. For breeding (parents, results, ranks) use the breeding tools instead - the wiki's breeding numbers lag behind the game.`,
      inputSchema: {
        query: z.string().min(1).describe('Search terms, e.g. "Bellanoir raid" or "how to get ancient civilization parts"'),
        limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)'),
      },
    },
    async ({ query, limit }) => {
      try {
        const { totalHits, results } = await wikiSearch(query, limit ?? 5);
        return text(JSON.stringify({ totalHits, count: results.length, results }, null, 2));
      } catch (error) {
        return fail(`wiki_search failed: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    'wiki_get_page',
    {
      title: 'Read a Palworld Wiki page',
      description:
        'Read one page of the Palworld Wiki (palworld.wiki.gg) as markdown - live, so it reflects the current game version. Give the exact page title (from wiki_search; pal, item and boss names usually are page titles). Long pages are cut at maxLength: the reply lists the page\'s sections, so pass section to read just one (e.g. section "Drops"). Do not take breeding ranks or parent combinations from wiki pages - they lag behind the game; use get_breeding_result, find_breeding_pairs and breeding_plan for those.',
      inputSchema: {
        title: z.string().min(1).describe('Page title, e.g. "Anubis", "Breeding", "Feybreak"'),
        section: z.string().min(1).optional().describe('Only this section of the page, by heading, e.g. "Drops" or "Strategy"'),
        maxLength: z.number().int().min(500).max(40000).optional().describe('Max characters of page text to return (default 8000)'),
      },
    },
    async ({ title, section, maxLength }) => {
      try {
        const page = await wikiGetPage(title, { section, maxLength });
        const header = [
          `# ${page.title}${page.section ? ` - ${page.section}` : ''}`,
          `Source: ${page.url} (Palworld Wiki, CC BY-SA)`,
          page.sections.length ? `Sections on this page: ${page.sections.join(', ')}` : undefined,
        ].filter((line) => line !== undefined);
        const footer = page.truncated
          ? `\n\n[Truncated: showing ${page.content.length} of ${page.originalLength} characters. Pass section to read one section, or raise maxLength.]`
          : '';
        return text(`${header.join('\n')}\n\n${page.content || '(this page has no text content)'}${footer}`);
      } catch (error) {
        if (error instanceof WikiPageNotFoundError) {
          // A wrong title is the common failure, so answer it with the nearest real ones.
          const suggestions = await wikiSearch(title, 5).catch(() => undefined);
          const titles = suggestions?.results.map((r) => r.title) ?? [];
          return fail(
            `No wiki page titled "${title}".` +
              (titles.length ? ` Closest pages: ${titles.join(', ')}.` : ' Try wiki_search to find the right title.'),
          );
        }
        if (error instanceof WikiSectionNotFoundError) {
          return fail(
            `"${title}" has no section "${error.section}".` +
              (error.available.length ? ` Sections: ${error.available.join(', ')}.` : ' The page has no sections; omit section.'),
          );
        }
        return fail(`wiki_get_page failed: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    'get_game_news',
    {
      title: 'Palworld news and patch notes',
      description:
        'Latest official Palworld announcements from the developer (Pocketpair) via the game\'s Steam news feed: patch notes, update and event announcements, newest first. Use it for "what is the latest version", "what changed in the last patch" or "what is coming next". query filters by title (e.g. "v1.0" for patch notes). Bodies are cut at maxLength; to read one announcement in full, pass a query matching its title with limit 1 and a larger maxLength.',
      inputSchema: {
        query: z.string().min(1).optional().describe('Only announcements whose title contains this text, e.g. "v1.0", "patch", "update"'),
        limit: z.number().int().min(1).max(10).optional().describe('Max announcements (default 5)'),
        maxLength: z.number().int().min(200).max(30000).optional().describe('Max characters of body text per announcement (default 1500)'),
      },
    },
    async ({ query, limit, maxLength }) => {
      try {
        const { totalMatching, items } = await getGameNews({ query, limit: limit ?? 5, maxLength: maxLength ?? 1500 });
        if (items.length === 0) {
          return text(query ? `No recent official announcements with "${query}" in the title.` : 'The Steam news feed returned no announcements.');
        }
        const blocks = items.map((item) => {
          const note = item.truncated ? `\n\n[Truncated: ${item.content.length} of ${item.originalLength} characters.]` : '';
          return `## ${item.title}\nDate: ${item.date}\nSource: ${item.url}\n\n${item.content}${note}`;
        });
        const heading = `Official Palworld announcements (Steam), newest first - showing ${items.length} of ${totalMatching} recent${query ? ` matching "${query}"` : ''}.`;
        return text(`${heading}\n\n${blocks.join('\n\n---\n\n')}`);
      } catch (error) {
        return fail(`get_game_news failed: ${(error as Error).message}`);
      }
    },
  );
}
