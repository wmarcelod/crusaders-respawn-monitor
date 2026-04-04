FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

RUN mkdir -p logs

ENV TS_MODE=bridge
ENV WEB_PORT=3000

EXPOSE 3000

CMD ["npx", "tsx", "src/web-server.ts"]
