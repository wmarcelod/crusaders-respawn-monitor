FROM node:20-bookworm-slim

# Install build tools for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

RUN mkdir -p logs data

ENV TS_MODE=bridge
ENV WEB_PORT=3000

EXPOSE 3000

CMD ["npx", "tsx", "src/web-server.ts"]
