/**
 * Live-tool tests. Nothing here touches the internet: the wiki and Steam
 * endpoints are pointed at a local stub server, so the suite is deterministic.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const PAL_HTML = `
<div class="mw-parser-output">
  <div class="pal-nav-banner"><a href="/wiki/Dualith_Noct">138B Dualith Noct</a></div>
  <div id="toc" class="toc"><ul><li>Obtaining</li></ul></div>
  <p><b>Anubis</b> is a <a href="/wiki/Ground" title="Ground">Ground</a> pal
     <span style="display:none">hidden</span><img src="/images/Anubis.png" alt="Anubis.png" />
     found in the <a href="/wiki/Twilight_Dunes_(Area)" title="Twilight Dunes (Area)">Twilight Dunes</a>.<sup class="reference">[1]</sup></p>
  <h2><span class="mw-headline">Drops</span><span class="mw-editsection">[edit]</span></h2>
  <table>
    <tr><th>Item</th><th>Amount</th><th>Chance</th></tr>
    <tr><td><a href="/wiki/Bone"><img src="/b.png" /></a> <a href="/wiki/Bone">Bone</a></td><td>3-5</td><td>100%</td></tr>
    <tr><td><a href="/wiki/Large_Pal_Soul">Large Pal Soul</a></td><td>1</td><td>20%</td></tr>
  </table>
  <div class="navbox"><a href="/wiki/Lamball">Lamball</a></div>
</div>`;

const SECTIONS = [
  { index: '1', line: 'Obtaining', level: '2' },
  { index: '2', line: 'Drops', level: '2' },
  { index: '', line: 'Normal Drops', level: '3' },
  { index: '3', line: 'Partner <i>Skill</i>', level: '2' },
];

const NEWS = [
  {
    gid: '2',
    title: 'v1.0.5 Patch Notes',
    url: 'https://example.test/news/2',
    date: 1789430400, // 2026-09-15
    contents:
      '[p][img src="{STEAM_CLAN_IMAGE}/1/a.png"][/img][/p][h2][Major Bug Fixes][/h2][list][*][p]Fixed a crash &amp; a typo[/p][/*][*]Second fix[/list]' +
      '[p]See [url="https://example.test/full"]the full notes[/url] or [dynamiclink href="https://example.test/store"][/dynamiclink][/p]',
  },
  { gid: '1', title: 'Summer Sale', url: 'https://example.test/news/1', date: 1780000000, contents: `[p]${'Sale! '.repeat(400)}[/p]` },
];

const requests: string[] = [];
let stub: http.Server;
let wiki: typeof import('../src/wiki.js');
let news: typeof import('../src/news.js');
let markdown: typeof import('../src/markdown.js');
let fetchUtil: typeof import('../src/fetch-json.js');

before(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    requests.push(`${req.headers['user-agent'] ?? ''} ${url.pathname}${url.search}`);
    const q = url.searchParams;
    const send = (body: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));

    if (url.pathname === '/steam') {
      assert.equal(q.get('feeds'), 'steam_community_announcements');
      return send({ appnews: { newsitems: NEWS } });
    }
    if (url.pathname === '/broken') return send({ error: 'nope' }, 503);
    if (q.get('action') === 'query') {
      const term = q.get('srsearch') ?? '';
      return send({
        query: {
          searchinfo: { totalhits: 67 },
          search: term.includes('zzz')
            ? []
            : [{ title: 'Anubis', snippet: 'Guardian of the <span class="searchmatch">Dark</span> Sun &amp; more&#039;s', timestamp: '2026-11-09T12:58:49Z' }],
        },
      });
    }
    if (q.get('action') === 'parse') {
      if (q.get('page') === 'Missing') return send({ error: { code: 'missingtitle', info: "The page you specified doesn't exist." } });
      if (q.get('prop') === 'sections') return send({ parse: { title: 'Anubis', sections: SECTIONS } });
      if (q.get('section')) return send({ parse: { title: 'Anubis', text: `<h2>Drops</h2><p>section ${q.get('section')} only</p>` } });
      return send({ parse: { title: 'Anubis', text: PAL_HTML, sections: SECTIONS } });
    }
    return send({ error: { code: 'unknown', info: 'unexpected request' } });
  });
  await new Promise<void>((done) => stub.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  // The clients read their endpoints at import time, so set these first.
  process.env.PALWORLD_WIKI_API = `${origin}/api.php`;
  process.env.PALWORLD_STEAM_NEWS_API = `${origin}/steam`;
  wiki = await import('../src/wiki.js');
  news = await import('../src/news.js');
  markdown = await import('../src/markdown.js');
  fetchUtil = await import('../src/fetch-json.js');
});

after(() => new Promise<void>((done) => stub.close(() => done())));

test('htmlToMarkdown drops wiki chrome and keeps content', () => {
  const md = markdown.htmlToMarkdown(PAL_HTML);
  assert.match(md, /Anubis is a Ground pal/);
  assert.match(md, /found in the Twilight Dunes\./); // link with parentheses in its URL fully stripped
  assert.match(md, /^## Drops$/m);
  assert.match(md, /^\| Item \| Amount \| Chance \|$/m);
  assert.match(md, /^\| Bone \| 3-5 \| 100% \|$/m);
  assert.match(md, /^\| Large Pal Soul \| 1 \| 20% \|$/m);
  for (const gone of ['Dualith', 'Lamball', 'hidden', 'edit', '.png', '[1]', '](', 'Obtaining']) {
    assert.ok(!md.includes(gone), `expected "${gone}" to be stripped from:\n${md}`);
  }
});

test('htmlToMarkdown flattens the pal infobox', () => {
  const icon = (name: string) => `<a href="/wiki/${name}" title="${name}"><img alt="${name}" src="/i.png" width="30" height="30" /></a>`;
  const md = markdown.htmlToMarkdown(`
    <div class="druid-section">
      <div class="druid-toggleable-heading druid-toggleable focused">Work Suitability</div>
      <div class="druid-toggleable-heading druid-toggleable druid-toggleable-heading-empty">Work Suitability</div>
    </div>
    <div class="druid-grid">
      <div class="druid-grid-item"><div class="druid-data"><span class="pal-work-zero">${icon('Kindling')} Lv 0</span></div></div>
      <div class="druid-grid-item"><div class="druid-data"><span>${icon('Mining')} Lv 6</span></div><div class="druid-toggleable-data-empty">x</div></div>
    </div>
    <div class="druid-row"><div class="druid-label">Element</div><div class="druid-data">${icon('Ground')} <a href="/wiki/Ground">Ground</a></div></div>
    <div class="druid-row"><div class="druid-data"><div class="pal-active-skill-list">
      <div class="pal-active-skill-row"><div><span class="pal-active-skill-lv">Lv 1</span><span><a href="/wiki/Stone_Blast">Stone Blast</a></span></div><div>${icon('Ground')}<span>80</span></div></div>
      <div class="pal-active-skill-row"><div><span class="pal-active-skill-lv">Lv 7</span><span><a href="/wiki/Power_Bomb">Power Bomb</a></span></div><div>${icon('Neutral')}<span>120</span></div></div>
    </div></div></div>
    <p>A <i>usekh</i>-style collar (rank_a).</p>
    <details><summary>Habitat Map</summary><div class="ext-datamaps-container" data-mw-datamaps="map">Loading scripts</div></details>`);
  assert.equal(
    md,
    ['Work Suitability', 'Mining Lv 6', 'Element Ground', 'Lv 1 Stone Blast Ground 80', 'Lv 7 Power Bomb Neutral 120', 'A usekh-style collar (rank_a).'].join('\n\n'),
  );
});

test('truncateContent cuts at a boundary and reports the original length', () => {
  const body = `intro paragraph\n\n## One\n${'a'.repeat(300)}\n\n## Two\n${'b'.repeat(300)}`;
  const cut = markdown.truncateContent(body, 400);
  assert.equal(cut.truncated, true);
  assert.equal(cut.originalLength, body.length);
  assert.ok(cut.content.length <= 400);
  assert.ok(cut.content.endsWith('a'), 'cut lands before the "## Two" heading');
  assert.deepEqual(markdown.truncateContent('short', 400), { content: 'short', truncated: false, originalLength: 5 });
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(markdown.decodeEntities('a &amp; b &#039;c&#x27; &lt;d&gt; &bogus;'), "a & b 'c' <d> &bogus;");
});

test('wikiSearch returns cleaned snippets and page URLs', async () => {
  const out = await wiki.wikiSearch('Anubis', 3);
  assert.equal(out.totalHits, 67);
  assert.deepEqual(out.results, [
    { title: 'Anubis', snippet: "Guardian of the Dark Sun & more's", url: 'https://palworld.wiki.gg/wiki/Anubis', lastEdited: '2026-11-09T12:58:49Z' },
  ]);
  assert.match(requests.at(-1)!, /^palworld-mcp\S* \(\+https:\/\/\S+\) \/api\.php\?/, 'sends a descriptive User-Agent');
  assert.equal(wiki.wikiPageUrl('Sphere (Item)/Sub page'), 'https://palworld.wiki.gg/wiki/Sphere_(Item)/Sub_page');
});

test('wikiGetPage: whole page, one section, truncation and errors', async () => {
  const page = await wiki.wikiGetPage('Anubis');
  assert.equal(page.title, 'Anubis');
  assert.deepEqual(page.sections, ['Obtaining', 'Drops', 'Partner Skill']);
  assert.equal(page.truncated, false);
  assert.match(page.content, /\| Bone \| 3-5 \| 100% \|/);

  const section = await wiki.wikiGetPage('Anubis', { section: 'drops' });
  assert.equal(section.section, 'Drops');
  assert.match(section.content, /section 2 only/);

  const partial = await wiki.wikiGetPage('Anubis', { section: 'partner' });
  assert.equal(partial.section, 'Partner Skill');
  assert.match(partial.content, /section 3 only/);

  const short = await wiki.wikiGetPage('Anubis', { maxLength: 60 });
  assert.equal(short.truncated, true);
  assert.ok(short.content.length <= 60);
  assert.ok(short.originalLength > 60);

  await assert.rejects(wiki.wikiGetPage('Missing'), wiki.WikiPageNotFoundError);
  await assert.rejects(wiki.wikiGetPage('Anubis', { section: 'Nope' }), (error: unknown) => {
    assert.ok(error instanceof wiki.WikiSectionNotFoundError);
    assert.deepEqual(error.available, ['Obtaining', 'Drops', 'Normal Drops', 'Partner Skill']);
    return true;
  });
});

test('steamMarkupToText converts announcement markup, keeping literal brackets', () => {
  const text = news.steamMarkupToText(NEWS[0]!.contents);
  assert.equal(
    text,
    [
      '### [Major Bug Fixes]',
      '',
      '- Fixed a crash & a typo',
      '- Second fix',
      '',
      'See the full notes (https://example.test/full) or https://example.test/store',
    ].join('\n'),
  );
});

test('getGameNews filters by title, limits and truncates', async () => {
  const all = await news.getGameNews();
  assert.equal(all.totalMatching, 2);
  assert.deepEqual(all.items.map((i) => [i.title, i.date]), [['v1.0.5 Patch Notes', '2026-09-15'], ['Summer Sale', '2026-05-28']]);
  assert.equal(all.items[1]!.truncated, true);
  assert.ok(all.items[1]!.content.length <= 1500);

  const patch = await news.getGameNews({ query: 'PATCH', limit: 1, maxLength: 30000 });
  assert.equal(patch.totalMatching, 1);
  assert.equal(patch.items[0]!.url, 'https://example.test/news/2');
  assert.equal(patch.items[0]!.truncated, false);

  assert.deepEqual(await news.getGameNews({ query: 'nothing like this' }), { totalMatching: 0, items: [] });
});

test('fetchJson caches by URL and surfaces upstream failures', async () => {
  fetchUtil.clearFetchCache();
  const before = requests.length;
  await wiki.wikiSearch('cache me', 2);
  await wiki.wikiSearch('cache me', 2);
  assert.equal(requests.length - before, 1, 'second identical call is served from cache');

  const origin = new URL(process.env.PALWORLD_WIKI_API!).origin;
  await assert.rejects(fetchUtil.fetchJson(`${origin}/broken`), /answered HTTP 503/);
  await assert.rejects(fetchUtil.fetchJson('http://127.0.0.1:1/unreachable', { timeoutMs: 2000 }), fetchUtil.UpstreamError);
});
