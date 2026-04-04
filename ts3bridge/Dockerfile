FROM eclipse-temurin:21-jdk-jammy AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts ./scripts
COPY src ./src
COPY vendor ./vendor

RUN chmod +x ./scripts/*.sh && ./scripts/build.sh

FROM eclipse-temurin:21-jre-jammy AS runtime

WORKDIR /app

COPY --from=build /app/build ./build
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/src ./src

RUN mkdir -p /app/data && chmod +x ./scripts/*.sh

ENV TS_SERVER=169.197.140.171
ENV TS_SERVER_PORT=9989
ENV TS_NICKNAME=CrusaderBridge
ENV BRIDGE_PORT=8080
ENV IDENTITY_FILE=/app/data/identity.ini

EXPOSE 8080

CMD ["./scripts/run.sh"]
