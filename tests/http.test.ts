/**
 * Streamable HTTP harness: spawns the real server with MCP_TRANSPORT=http on an
 * ephemeral port and drives it with the SDK's HTTP client - the path Open WebUI
 * and other HTTP-only MCP clients use.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'src', 'index.ts');

interface Running {
  child: ChildProcess;
  origin: string;
}

/** Starts the server on port 0 and resolves once it logs the port it bound. */
function startServer(env: Record<string, string>): Promise<Running> {
  return new Promise((resolveStart, rejectStart) => {
    // `--import tsx` rather than the tsx CLI: the CLI runs the script in a
    // grandchild, which would outlive a kill of the process we hold.
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
      cwd: ROOT,
      env: { ...process.env, MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1', MCP_PORT: '0', ...env },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let log = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectStart(new Error(`server did not start within 20s:\n${log}`));
    }, 20000);
    child.stderr!.on('data', (chunk: Buffer) => {
      log += chunk.toString();
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\/mcp/.exec(log);
      if (match) {
        clearTimeout(timer);
        resolveStart({ child, origin: match[1]! });
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new Error(`server exited early (code ${code}):\n${log}`));
    });
  });
}

async function connect(origin: string): Promise<Client> {
  const client = new Client({ name: 'http-harness', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  return client;
}

test('Streamable HTTP: health, sessions, tools and offline mode', async () => {
  const { child, origin } = await startServer({ PALWORLD_MCP_OFFLINE: '1' });
  try {
    const health = await fetch(`${origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', sessions: 0 });

    assert.equal((await fetch(`${origin}/nope`)).status, 404);

    // A request that is neither an initialize nor part of a session is refused.
    const stray = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(stray.status, 400);

    // A stale session id (e.g. after a server restart) gets 404 so clients re-initialize.
    const stale = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'gone' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(stale.status, 404);

    const garbage = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(garbage.status, 400);

    // Two concurrent clients each get their own session and server.
    const [a, b] = await Promise.all([connect(origin), connect(origin)]);
    try {
      const sessions = (await (await fetch(`${origin}/healthz`)).json()) as { sessions: number };
      assert.equal(sessions.sessions, 2);

      const tools = await a.listTools();
      // PALWORLD_MCP_OFFLINE=1 leaves the network tools out.
      assert.deepEqual(
        tools.tools.map((x) => x.name).sort(),
        ['breeding_plan', 'find_breeding_pairs', 'get_breeding_result', 'get_item', 'get_pal', 'search_items', 'search_pals', 'search_skills'],
      );

      const [palA, palB] = await Promise.all([
        a.callTool({ name: 'get_pal', arguments: { name: 'Anubis' } }),
        b.callTool({ name: 'get_pal', arguments: { name: 'Lamball' } }),
      ]);
      const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
      assert.equal(JSON.parse(text(palA)).pal.name, 'Anubis');
      assert.equal(JSON.parse(text(palB)).pal.name, 'Lamball');
    } finally {
      await Promise.allSettled([a.close(), b.close()]);
    }
  } finally {
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    child.stderr?.destroy();
  }
});
