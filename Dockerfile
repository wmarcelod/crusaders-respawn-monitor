FROM node:20-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source and config
COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

# Create logs directory
RUN mkdir -p logs

# Default: ServerQuery mode for remote deployment
ENV TS_MODE=serverquery
ENV WEB_PORT=3000

EXPOSE 3000

CMD ["npx", "tsx", "src/web-server.ts"]
