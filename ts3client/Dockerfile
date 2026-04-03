FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# Install minimal dependencies for TS3 client + Xvfb
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
    libfreetype6 \
    libfontconfig1 \
    libnss3 \
    libasound2 \
    libpulse0 \
    libdbus-1-3 \
    libglib2.0-0 \
    libgl1-mesa-glx \
    libqt5core5a \
    libqt5gui5 \
    libqt5widgets5 \
    libqt5network5 \
    libqt5sql5 \
    libqt5sql5-sqlite \
    libqt5svg5 \
    libqt5qml5 \
    libqt5quick5 \
    libqt5quickwidgets5 \
    libqt5websockets5 \
    wget \
    ca-certificates \
    bzip2 \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash ts3user

# Download and extract TS3 client 3.6.2
WORKDIR /opt
RUN wget -q "https://files.teamspeak-services.com/releases/client/3.6.2/TeamSpeak3-Client-linux_amd64-3.6.2.run" -O ts3client.run && \
    chmod +x ts3client.run && \
    yes | ./ts3client.run && \
    chown -R ts3user:ts3user /opt/TeamSpeak3-Client-linux_amd64 && \
    rm ts3client.run

# Copy startup script
COPY start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

USER ts3user
WORKDIR /home/ts3user

# ClientQuery port
EXPOSE 25639

ENTRYPOINT ["/opt/start.sh"]
