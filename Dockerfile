FROM node:20-alpine

WORKDIR /app

# Install netcat for health checks
RUN apk add --no-cache netcat-openbsd

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source and config
COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

# Create directories
RUN mkdir -p logs

# Copy startup script and fix line endings
COPY start-monitor.sh ./
RUN chmod +x start-monitor.sh && sed -i 's/\r$//' start-monitor.sh

# Default: ClientQuery mode (connects to ts3client container)
ENV TS_MODE=clientquery
ENV WEB_PORT=3000

EXPOSE 3000

CMD ["./start-monitor.sh"]
