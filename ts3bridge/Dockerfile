FROM maven:3.9-eclipse-temurin-11 AS build
WORKDIR /app

# Cache dependencies first
COPY pom.xml .
RUN mvn dependency:resolve dependency:resolve-plugins -q

# Build the project
COPY src/ ./src/
RUN mvn package -DskipTests -q

# Runtime image (small)
FROM eclipse-temurin:11-jre-alpine
WORKDIR /app

COPY --from=build /app/target/ts3bridge-1.0.0.jar ./ts3bridge.jar

# Create data directory for identity persistence
RUN mkdir -p /data

ENV TS_SERVER=crusaders.expto.com.br
ENV TS_SERVER_PORT=9987
ENV TS_NICKNAME=CrusaderBridge
ENV BRIDGE_PORT=8080
ENV IDENTITY_FILE=/data/identity.ini

EXPOSE 8080

CMD ["java", "-jar", "ts3bridge.jar"]
