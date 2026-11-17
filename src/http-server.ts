/**
 * Streamable HTTP transport for palworld-mcp.
 *
 * Open WebUI (and other HTTP-only MCP clients) cannot speak stdio. Serving the
 * protocol natively means no supergateway or other bridge process is needed -
 * this sits directly on Node's `http` module and hands raw request/response
 * pairs to the SDK's `StreamableHTTPServerTransport`, so it adds no Express and
 * no extra dependencies.
 *
 * Differences from stdio:
 *  - The transport is session-scoped. Each client that POSTs an `initialize`
 *    gets its own transport bound to a fresh server (see `serverFactory`),
 *    keyed by the `mcp-session-id` header it echoes back on later requests.
 *  - `GET` opens the SSE stream for server-initiated messages; `DELETE` ends a
 *    session.
 *  - POST responses default to plain JSON (`enableJsonResponse: true`), which is
 *    friendlier for curl and tests than the spec's default SSE streaming.
 *
 * Ported from https://github.com/benfugate/mcp-osrs (MIT), itself adapted from
 * https://github.com/maxgauthier12/mcp-osrs (MIT).
 */
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_MCP_PATH = '/mcp';
export const DEFAULT_HEALTH_PATH = '/healthz';
const MAX_BODY_BYTES = 5 * 1024 * 1024; // safety cap on JSON-RPC payloads

export interface HttpServerOptions {
  /** Builds a fresh, fully-configured MCP server per client session. */
  serverFactory: () => McpServer;
  /** Path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  path?: string;
  /** Path for the liveness probe. Defaults to `/healthz`. */
  healthPath?: string;
  /** Return plain `application/json` from POST instead of an SSE stream. */
  enableJsonResponse?: boolean;
  /** Permissive CORS headers, so browser clients (MCP Inspector) work. */
  enableCors?: boolean;
  /** Listen port. Defaults to MCP_PORT || PORT || 8000. */
  port?: number;
  /** Listen host. Defaults to MCP_HOST || 127.0.0.1. */
  host?: string;
}

/** One live client session: its bound MCP server plus the transport it uses. */
export interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface HttpApp {
  handler: http.RequestListener;
  /** Live sessions keyed by `mcp-session-id`. Exposed for tests. */
  sessions: Map<string, SessionEntry>;
  options: Required<Pick<HttpServerOptions, 'path' | 'healthPath' | 'enableJsonResponse' | 'enableCors'>>;
}

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

/**
 * Patches `res.writeHead` so responses written by the SDK transport also carry
 * the CORS headers. Deliberately small and framework-free.
 */
function withCors(res: http.ServerResponse): http.ServerResponse {
  const writeHead = res.writeHead.bind(res) as (
    statusCode: number,
    headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    reasonPhrase?: string,
  ) => http.ServerResponse;
  (res.writeHead as unknown) = (
    statusCode: number,
    headers?: http.OutgoingHttpHeaders | http.OutgoingHttpHeader[],
    reasonPhrase?: string,
  ) =>
    writeHead(
      statusCode,
      typeof headers === 'object' && headers !== null && !Array.isArray(headers)
        ? { ...headers, ...CORS_HEADERS }
        : headers,
      reasonPhrase,
    );
  return res;
}

/** Read and JSON.parse the request body, enforcing a size cap. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) throw new Error('Empty request body');
  return JSON.parse(raw);
}

function sessionIdFrom(req: http.IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonRpcError(status: number, code: number, message: string, res: http.ServerResponse): void {
  res
    .writeHead(status, { 'Content-Type': 'application/json' })
    .end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

/**
 * Build the request handler and its live session map, without starting a
 * listener - so tests can mount it on an ephemeral port.
 */
export function createHttpApp(options: HttpServerOptions): HttpApp {
  const {
    serverFactory,
    path = DEFAULT_MCP_PATH,
    healthPath = DEFAULT_HEALTH_PATH,
    enableJsonResponse = true,
    enableCors = true,
  } = options;
  const mountPath = path.startsWith('/') ? path : `/${path}`;
  const healthMount = healthPath.startsWith('/') ? healthPath : `/${healthPath}`;

  const sessions = new Map<string, SessionEntry>();

  const handler: http.RequestListener = async (req, res) => {
    const target = enableCors ? withCors(res) : res;

    try {
      if (req.method === 'OPTIONS') {
        target.writeHead(204, CORS_HEADERS).end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');

      // Liveness probe, so container runtimes have something cheap to poll that
      // does not open an MCP session.
      if (url.pathname === healthMount) {
        target
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
        return;
      }

      if (url.pathname !== mountPath) {
        target.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      // SSE stream and session termination both key off the session header.
      if (req.method === 'GET' || req.method === 'DELETE') {
        const sessionId = sessionIdFrom(req);
        const entry = sessionId ? sessions.get(sessionId) : undefined;
        if (!entry) {
          jsonRpcError(400, -32000, 'Invalid or missing session ID', target);
          return;
        }
        await entry.transport.handleRequest(req, target);
        return;
      }

      if (req.method !== 'POST') {
        target
          .writeHead(405, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'Method not allowed' }));
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        jsonRpcError(400, -32700, `Parse error: ${(error as Error).message}`, target);
        return;
      }

      const sessionId = sessionIdFrom(req);
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        await existing.transport.handleRequest(req, target, body);
        return;
      }

      // No (known) session, so this only makes sense as a new initialize.
      if (!isInitializeRequest(body)) {
        // 404 for an unknown-but-present session id tells a spec-following
        // client to re-initialize (e.g. after this server restarted).
        if (sessionId) jsonRpcError(404, -32001, 'Session not found', target);
        else jsonRpcError(400, -32000, 'Bad Request: missing session id and body is not an initialize request', target);
        return;
      }

      // A fresh transport and a fresh server per client, so concurrent clients
      // never share protocol state.
      const server = serverFactory();
      const entry: SessionEntry = {
        server,
        transport: new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse,
          onsessioninitialized: (id) => {
            sessions.set(id, entry);
          },
        }),
      };
      const { transport } = entry;

      await server.connect(transport);
      // connect() replaces transport.onclose with the SDK's own handler, so
      // chain session cleanup on *after* connecting - otherwise the entry would
      // never leave the map.
      const protocolOnclose = transport.onclose;
      transport.onclose = () => {
        protocolOnclose?.call(transport);
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      await transport.handleRequest(req, target, body);
    } catch (error) {
      // The SDK transport reports its own 400s; only fall through to a 500 for
      // unexpected failures, and never clobber a response in flight.
      if (target.headersSent) {
        target.destroy();
      } else {
        console.error('[palworld-mcp] HTTP request failed:', error);
        jsonRpcError(500, -32603, 'Internal server error', target);
      }
    }
  };

  return {
    handler,
    sessions,
    options: { path: mountPath, healthPath: healthMount, enableJsonResponse, enableCors },
  };
}

/** Start a listener and wire graceful shutdown. */
export async function startHttpServer(options: HttpServerOptions): Promise<http.Server> {
  const { handler: app, sessions, options: resolved } = createHttpApp(options);
  const port = options.port ?? Number(process.env.MCP_PORT ?? process.env.PORT ?? 8000);
  // Loopback by default so a dev run is not exposed; containers set
  // MCP_HOST=0.0.0.0, without which the port would be unreachable from outside.
  const host = options.host ?? process.env.MCP_HOST ?? '127.0.0.1';

  const server = http.createServer(app);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.error(
    `[palworld-mcp] Streamable HTTP listening on http://${host}:${boundPort}${resolved.path} (health: ${resolved.healthPath})`,
  );

  const shutdown = (signal: string) => {
    console.error(`[palworld-mcp] received ${signal}, shutting down`);
    void Promise.allSettled([...sessions.values()].map((s) => s.transport.close())).finally(() =>
      server.close(() => process.exit(0)),
    );
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}
