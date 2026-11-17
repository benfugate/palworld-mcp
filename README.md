# Palworld MCP

MCP (Model Context Protocol) server for Palworld database queries - pals, breeding, items, recipes. Data is sourced from [paldb.cc](https://paldb.cc) and [palcalc-tools](https://github.com/palcalc-tools/palworld-1.0-calculator), compiled into a single offline dataset that ships with this repository.

**Offline-first:** the pal, item, skill and breeding tools read from the shipped `data/dataset.json` at runtime. Users never contact paldb.cc.

**Live where it helps:** three optional tools reach the network for what a snapshot cannot hold - the community [Palworld Wiki](https://palworld.wiki.gg) (guides, bosses, locations, mechanics, anything added since the dataset was built) and the developer's official announcements and patch notes. Set `PALWORLD_MCP_OFFLINE=1` to leave them out.

**Two transports:** stdio (default) for desktop clients, or native Streamable HTTP (`MCP_TRANSPORT=http`) for HTTP-only clients such as Open WebUI - no bridge process needed.

## Tools

| Tool | What it does |
|---|---|
| `search_pals` | Search the pal roster by name, element, base stats (HP/ATK/DEF), capture rate, boss availability, breedability, or work suitability |
| `get_pal` | Full record for one pal: stats, element, breeding rank, skills, drops, work suitability, spawns, food |
| `get_breeding_result` | Offspring of two parents (unique combos, identity, rank math with eligible-pal exclusion) |
| `find_breeding_pairs` | Reverse lookup: which parent pairs produce a given child (optional `givenParent` filter) |
| `breeding_plan` | Multi-step breeding path solver: target pal + owned pals -> ranked step-by-step plans |
| `search_items` | Search items by name, type, or rarity |
| `get_item` | Full item record: rarity, price, weight, drops, shops, and every crafting recipe it appears in |
| `search_skills` | Reverse skill index: which pals learn an active skill, carry a passive, or have a partner skill. `query` matches a skill's name or effect description (e.g. find the partner skill that boosts player attack); also filter by kind, element, power |

| `wiki_search` | **Live.** Full-text search of the Palworld Wiki - titles, snippets, last-edited date |
| `wiki_get_page` | **Live.** One wiki page, or one `section` of it, as markdown (page chrome, icons and navboxes stripped; capped by `maxLength`) |
| `get_game_news` | **Live.** Official Pocketpair announcements and patch notes from the game's Steam news feed, newest first; `query` filters by title |

For breeding, trust the breeding tools over the wiki: the wiki's breeding ranks still show pre-1.0 values for many pals, while the dataset's ranks and tie-break rule match the 1.0 game data.

## Requirements

- Node.js ≥ 18
- npm

## Install & build

The package is published to npm - install it from a client project:

```bash
npm i palworld-mcp
```

Then point your MCP client at `node_modules/palworld-mcp/dist/index.js`:

```json
{
  "mcpServers": {
    "palworld": {
      "command": "node",
      "args": ["C:/absolute/path/to/your-project/node_modules/palworld-mcp/dist/index.js"]
    }
  }
}
```

Working from this repository instead (development):

```bash
npm install
npm run build
```

`dist/` is gitignored - build once after cloning (the MCP server runs from `dist/index.js`).

## Register with an MCP client

Any MCP-compatible client (Claude Desktop, Hermes, opencode, etc.) - the server speaks stdio. With the package installed via npm, register it with the path from the Install section; from a dev checkout, point at the built `dist/index.js`:

```json
{
  "mcpServers": {
    "palworld": {
      "command": "node",
      "args": ["C:/absolute/path/to/project/node_modules/palworld-mcp/dist/index.js"]
    }
  }
}
```

To serve a dataset from another location, set `PALWORLD_MCP_DATA` to the path of a `dataset.json`.

## Streamable HTTP and Docker

Set `MCP_TRANSPORT=http` and the server listens for MCP over Streamable HTTP instead of stdio:

```bash
MCP_TRANSPORT=http MCP_PORT=8000 node dist/index.js
# -> http://127.0.0.1:8000/mcp   (liveness probe: /healthz)
```

Each client session gets its own server instance, so several clients can connect at once. It binds loopback unless `MCP_HOST` says otherwise.

A container image is published to GHCR on every push to `master` (`linux/amd64` and `linux/arm64`). The image sets `MCP_HOST=0.0.0.0`; you choose the transport:

```bash
docker run -d --name palworld-mcp -p 8102:8000 -e MCP_TRANSPORT=http ghcr.io/franshjy/palworld-mcp:latest
```

Then add `http://<host>:8102/mcp` to the client. In Open WebUI: Admin Panel -> Settings -> Tools (called Integrations in newer versions) -> add a connection of type **MCP (Streamable HTTP)**, no auth.

Without `MCP_TRANSPORT` the same image speaks stdio (`docker run -i --rm ghcr.io/franshjy/palworld-mcp`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` (Streamable HTTP) |
| `MCP_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Listen address for HTTP |
| `MCP_PORT` | `8000` | Listen port for HTTP (`PORT` is also honoured) |
| `PALWORLD_MCP_DATA` | shipped `data/dataset.json` | Path to another dataset file |
| `PALWORLD_MCP_OFFLINE` | unset | `1` removes the live tools (`wiki_*`, `get_game_news`) - nothing touches the network |
| `PALWORLD_MCP_USER_AGENT` | `palworld-mcp/<version> (+repo URL)` | User-Agent sent to the wiki and Steam |

Live responses are cached in memory for 10 minutes.

## Example queries

- **"Find a fast mining pal"** -> `search_pals { workSuitability: "Mining", sortBy: "rank" }`
- **"What does Anubis look like?"** -> `get_pal { name: "Anubis" }`
- **"What do I get from Jetragon + Frostallion?"** -> `get_breeding_result { parent1: "Jetragon", parent2: "Frostallion" }`
- **"I have Lamball and Foxparks, what can I breed towards?"** -> `breeding_plan { target: "Anubis", owned: ["Lamball", "Foxparks", "Chikipi", "Pengullet"] }`
- **"Which weapons use Hexolite?"** -> `get_item { name: "Hexolite" }` -> read `usedInCrafting`
- **"How do I beat the Bellanoir raid?"** -> `wiki_search { query: "Bellanoir raid" }` -> `wiki_get_page { title: "Bellanoir", section: "Strategy" }`
- **"What changed in the latest patch?"** -> `get_game_news { query: "v1.", limit: 1, maxLength: 8000 }`

## Breeding model

- Child rank = `floor((rankA + rankB + 1) / 2)`; the result is the nearest **eligible** pal to that rank (116 pals are excluded from being results), ties resolve to the higher rank.
- 136 fixed unique combos override rank math; one directional pair (Katress + Wixen) depends on which parent is male.
- Breeding a pal with itself yields the same pal.
- Rank reflects breeding rarity, **not** catch difficulty.

## Data pipeline (owner-side only)

The dataset is rebuilt by the maintainer; end users just use it.

```bash
npm run refresh     # fetch pal stats + breeding table (paldb.cc, palcalc) and build the base dataset
npm run mirror      # crawl pal + item pages from paldb.cc into data/raw/ (throttled, resumable)
npm run parse-pages # parse the mirror: items + pal enrichment, merge into dataset.json (schema v2)
```

`data/raw/` (mirrored HTML) is gitignored - only the parsed `data/dataset.json` ships. The build is gated: 299 pals, every combo referencing known codes, ranks cross-checked against paldb's farm page and palcalc, and a canary on `iv_en.json`. Refresh after major game updates; the dataset records `gameVersion` for reference.

## Dataset

`data/dataset.json` (schema v2): 299 pals + 2,169 items, with skills, drops, work suitability, spawns, food, and crafting recipes. The `sources` field records provenance and license status for each upstream.

## Development

```bash
npm test        # node:test suite (stdio + HTTP server harnesses, breeding vectors, live tools against a local stub)
npm run dev     # run from source via tsx (no build step)
```

The same suite runs in Docker, with nothing installed on the host - this is what CI does:

```bash
docker build --target test -t palworld-mcp:test . && docker run --rm palworld-mcp:test
```

No test touches the internet: the wiki and Steam clients are pointed at a local stub server.

## Licensing

- **Code** (src/, scripts/, tests/): MIT - see [LICENSE](LICENSE).
- **Dataset** (`data/dataset.json`): CC BY 4.0 - see [LICENSE.data](LICENSE.data).
- **Provenance & attribution** (paldb.cc, palcalc, Pocketpair game data): see [NOTICE](NOTICE).
- **Live tools** return third-party content fetched at request time, not shipped here: Palworld Wiki text (CC BY-SA, each result carries its page URL) and Pocketpair's own announcements via Steam.

Palworld is a trademark of Pocketpair, Inc. This is an unofficial fan project, not affiliated with or endorsed by Pocketpair.
