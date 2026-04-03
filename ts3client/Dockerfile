FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# Install dependencies for TS3 client + Xvfb
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    libx11-6 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    libxss1 \
    libxkbcommon0 \
    libfreetype6 \
    libfontconfig1 \
    libnss3 \
    libasound2 \
    libpulse0 \
    libdbus-1-3 \
    libglib2.0-0 \
    libegl1-mesa \
    libgl1-mesa-glx \
    wget \
    ca-certificates \
    bzip2 \
    sqlite3 \
    netcat-openbsd \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash ts3user

# Download and extract TS3 client 3.6.2 (using --noexec to skip interactive license)
WORKDIR /opt
RUN wget -q "https://files.teamspeak-services.com/releases/client/3.6.2/TeamSpeak3-Client-linux_amd64-3.6.2.run" -O ts3client.run \
    && chmod +x ts3client.run \
    && ./ts3client.run --noexec --target /opt/TeamSpeak3-Client-linux_amd64 \
    && chown -R ts3user:ts3user /opt/TeamSpeak3-Client-linux_amd64 \
    && rm ts3client.run

# Copy startup script (must be LF line endings)
COPY start.sh /opt/start.sh
RUN chmod +x /opt/start.sh && sed -i 's/\r$//' /opt/start.sh

USER ts3user
WORKDIR /home/ts3user

EXPOSE 25639

ENTRYPOINT ["/opt/start.sh"]
