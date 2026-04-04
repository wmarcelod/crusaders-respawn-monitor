# Stage 1: Build Java TS3 bridge (javac + vendored ts3j)
FROM eclipse-temurin:21-jdk-jammy AS bridge-build

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /bridge

COPY ts3bridge/scripts ./scripts
COPY ts3bridge/src ./src
COPY ts3bridge/vendor ./vendor

RUN chmod +x ./scripts/*.sh && ./scripts/build.sh

# Stage 2: Runtime with Java + Node.js
FROM eclipse-temurin:21-jre-jammy

# Install Node.js 20
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy bridge build artifacts
COPY --from=bridge-build /bridge/build ./bridge/build
COPY --from=bridge-build /bridge/lib ./bridge/lib

# Install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

# Create directories
RUN mkdir -p logs /app/bridge/data

ENV TS_MODE=bridge
ENV BRIDGE_URL=http://localhost:8080
ENV WEB_PORT=3000
ENV TS_SERVER=169.197.140.171
ENV TS_SERVER_PORT=9989
ENV TS_NICKNAME=CrusaderBridge
ENV BRIDGE_PORT=8080

EXPOSE 3000

# Start bridge in background, wait for it, then start dashboard
CMD ["sh", "-c", "cd /app/bridge && java -cp 'build/classes:lib/*' com.crusaders.bridge.TS3Bridge & sleep 8 && cd /app && npx tsx src/web-server.ts"]
