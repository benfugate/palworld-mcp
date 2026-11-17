# The server speaks stdio by default (what Claude Desktop / Claude Code expect).
# Set MCP_TRANSPORT=http for the native Streamable HTTP transport, which is what
# Open WebUI needs - no bridge or gateway process involved:
#
#   docker run -d -p 8102:8000 -e MCP_TRANSPORT=http <image>
#   -> http://<host>:8102/mcp   (health: /healthz)
#
# Tests:  docker build --target test -t palworld-mcp-test . && docker run --rm palworld-mcp-test

# Every dependency is pure JavaScript, so install and compile once on the build
# machine's own architecture and copy the result into each target image. A
# multi-arch build (amd64 + arm64) then never runs npm under emulation.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps

WORKDIR /app

# Copied first so the dependency layer survives source-only changes.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts


FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM deps AS test

COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
COPY scripts ./scripts
COPY data/dataset.json ./data/dataset.json
CMD ["npm", "test"]


FROM --platform=$BUILDPLATFORM node:22-alpine AS prod-deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts


FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY data/dataset.json ./data/dataset.json

# Only consulted when MCP_TRANSPORT=http. The server binds loopback by default,
# which inside a container would be unreachable from the host.
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=8000
EXPOSE 8000

USER node
CMD ["node", "/app/dist/index.js"]
