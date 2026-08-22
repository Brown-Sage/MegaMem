# MegaMem — Node 18+ (built and tested on 20)
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY scripts ./scripts
COPY .env.example atlas-vector-index.json ./

ENV NODE_ENV=production

# HTTP + SSE transport. MCP stdio mode ignores this.
EXPOSE 3000

# Default: run the HTTP server. For MCP stdio under Docker:
#   docker run --rm --env-file .env -i megamem node src/mcpServer.js
CMD ["npm", "start"]
