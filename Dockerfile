# Stage 1: Build Java TS3 bridge (ts3j)
FROM maven:3.9-eclipse-temurin-11 AS bridge-build
WORKDIR /bridge
COPY ts3bridge/pom.xml .
RUN mvn dependency:resolve dependency:resolve-plugins -q
COPY ts3bridge/src/ ./src/
RUN mvn package -DskipTests -q

# Stage 2: Node.js + Java runtime
FROM node:20-slim

# Install JRE for the bridge
RUN apt-get update && \
    apt-get install -y --no-install-recommends openjdk-11-jre-headless && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node.js dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY tsconfig.json ./
COPY respawn-aliases.json ./

# Copy built bridge JAR
COPY --from=bridge-build /bridge/target/ts3bridge-1.0.0.jar /app/ts3bridge.jar

# Create directories
RUN mkdir -p logs /data

# Bridge runs on localhost:8080 inside the container
ENV TS_MODE=bridge
ENV BRIDGE_URL=http://localhost:8080
ENV WEB_PORT=3000
ENV TS_SERVER=crusaders.expto.com.br
ENV TS_SERVER_PORT=9987
ENV TS_NICKNAME=CrusaderBridge
ENV BRIDGE_PORT=8080
ENV IDENTITY_FILE=/data/identity.ini

EXPOSE 3000

# Start bridge in background, wait for it, then start dashboard
CMD ["sh", "-c", "java -jar /app/ts3bridge.jar & sleep 5 && npx tsx src/web-server.ts"]
