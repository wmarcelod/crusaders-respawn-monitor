package com.crusaders.bridge;

import com.github.manevolent.ts3j.protocol.socket.client.LocalTeamspeakClientSocket;
import com.github.manevolent.ts3j.protocol.client.ClientConnectionState;
import com.github.manevolent.ts3j.identity.LocalIdentity;
import com.github.manevolent.ts3j.event.*;
import com.github.manevolent.ts3j.api.Channel;
import com.github.manevolent.ts3j.api.Client;
import com.github.manevolent.ts3j.command.SingleCommand;
import com.github.manevolent.ts3j.command.parameter.CommandSingleParameter;
import com.github.manevolent.ts3j.protocol.ProtocolRole;
import com.google.gson.Gson;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.Headers;

import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.GeneralSecurityException;
import java.util.*;
import java.util.concurrent.*;

/**
 * TS3 Bridge - Connects to a TS3 server as a regular client using the
 * ts3j library (Java implementation of the TS3 voice protocol).
 *
 * Uses an event-driven channel cache (onChannelList, onChannelEdit,
 * onChannelDescriptionChanged) since getChannelInfo() is not available
 * on all servers.
 *
 * Exposes an HTTP API so the Crusaders Respawn Monitor can query
 * channels, clients, descriptions, and send/receive messages.
 */
public class TS3Bridge {

    private static volatile LocalTeamspeakClientSocket tsClient;
    private static volatile boolean connected = false;
    private static final CopyOnWriteArrayList<Map<String, Object>> incomingMessages = new CopyOnWriteArrayList<>();
    private static final Gson gson = new Gson();
    private static final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(2);

    // In-memory log ring buffer for debug
    private static final CopyOnWriteArrayList<String> logBuffer = new CopyOnWriteArrayList<>();
    private static void log(String msg) {
        String line = "[" + System.currentTimeMillis() + "] " + msg;
        System.out.println(line);
        logBuffer.add(line);
        while (logBuffer.size() > 500) logBuffer.remove(0);
    }

    // Event-driven channel cache: channelId -> {channel_name, channel_description, ...}
    private static final ConcurrentHashMap<Integer, ConcurrentHashMap<String, String>> channelCache = new ConcurrentHashMap<>();

    // Client cache from join/leave events
    private static final ConcurrentHashMap<Integer, ConcurrentHashMap<String, String>> clientCache = new ConcurrentHashMap<>();

    // Configuration
    private static String serverAddr;
    private static int serverPort;
    private static String nickname;
    private static int httpPort;
    private static String identityUid = "unknown";
    private static volatile int lastKnownBotClid = -1; // Auto-learned from bot responses
    private static volatile LocalIdentity userIdentity = null; // User's identity for brief bot queries
    private static final Object tempConnLock = new Object(); // Serialize temp connections
    private static final Path DATA_DIR = Paths.get("data");
    private static final Path IDENTITY_FILE = DATA_DIR.resolve("identity.ini");
    private static final int IDENTITY_LEVEL = 10;

    // ========== MAIN ==========

    public static void main(String[] args) throws Exception {
        serverAddr = env("TS_SERVER", "169.197.140.171");
        serverPort = Integer.parseInt(env("TS_SERVER_PORT", "9989"));
        nickname = env("TS_NICKNAME", "CrusaderBridge");
        httpPort = Integer.parseInt(env("BRIDGE_PORT", "8080"));

        System.out.println("============================================");
        System.out.println("  TS3 Bridge (ts3j - Java)");
        System.out.println("============================================");
        System.out.println("  Server:    " + serverAddr + ":" + serverPort);
        System.out.println("  Nickname:  " + nickname);
        System.out.println("  HTTP API:  0.0.0.0:" + httpPort);
        System.out.println("============================================");

        Files.createDirectories(DATA_DIR);

        // Start HTTP server first (non-blocking)
        startHttpServer();

        // Load or create TS3 identity (bridge's own)
        LocalIdentity identity = loadIdentity();
        identityUid = identity.getUid().toBase64();
        System.out.println("  UID:       " + identityUid);

        // Load user's identity for brief bot queries
        String userIdentityB64 = System.getenv("USER_IDENTITY");
        if (userIdentityB64 != null && !userIdentityB64.isEmpty()) {
            try {
                byte[] iniBytes = Base64.getDecoder().decode(userIdentityB64);
                userIdentity = LocalIdentity.read(new ByteArrayInputStream(iniBytes));
                System.out.println("  UserUID:   " + userIdentity.getUid().toBase64());
                System.out.println("  Bot queries will use temporary user identity connection");
            } catch (Exception e) {
                System.out.println("  WARNING: Failed to parse USER_IDENTITY: " + e.getMessage());
            }
        } else {
            System.out.println("  USER_IDENTITY not set - bot queries use main connection");
        }
        System.out.println("============================================");

        // Connect (blocks forever with reconnection)
        connectWithRetry(identity);
    }

    private static String env(String key, String defaultVal) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : defaultVal;
    }

    // ========== IDENTITY ==========

    private static LocalIdentity loadIdentity() throws IOException, GeneralSecurityException {
        // Priority 1: TS_IDENTITY env var (base64-encoded identity INI file content)
        String tsIdentityB64 = System.getenv("TS_IDENTITY");
        if (tsIdentityB64 != null && !tsIdentityB64.isEmpty()) {
            try {
                byte[] iniBytes = Base64.getDecoder().decode(tsIdentityB64);
                try (InputStream in = new ByteArrayInputStream(iniBytes)) {
                    LocalIdentity identity = LocalIdentity.read(in);
                    log("[Bridge] Loaded identity from TS_IDENTITY env (level " + identity.getSecurityLevel() + ", UID=" + identity.getUid() + ")");
                    // Also save to file so it persists across restarts
                    saveIdentity(identity);
                    return identity;
                }
            } catch (Exception e) {
                log("[Bridge] WARNING: Failed to parse TS_IDENTITY env var: " + e.getMessage());
                log("[Bridge] TS_IDENTITY must be base64-encoded content of a TS3 identity INI file");
                log("[Bridge] Falling back to file/generated identity...");
            }
        }

        // Priority 2: Saved identity file
        if (Files.exists(IDENTITY_FILE)) {
            try (InputStream in = Files.newInputStream(IDENTITY_FILE)) {
                LocalIdentity identity = LocalIdentity.read(in);
                log("[Bridge] Loaded identity from file (level " + identity.getSecurityLevel() + ", UID=" + identity.getUid() + ")");
                if (identity.getSecurityLevel() < IDENTITY_LEVEL) {
                    log("[Bridge] Improving security level to " + IDENTITY_LEVEL + "...");
                    identity.improveSecurity(IDENTITY_LEVEL);
                    saveIdentity(identity);
                }
                return identity;
            }
        }

        // Priority 3: Generate new identity
        log("[Bridge] Generating new identity (security level " + IDENTITY_LEVEL + ")...");
        LocalIdentity identity = LocalIdentity.generateNew(IDENTITY_LEVEL);
        saveIdentity(identity);
        log("[Bridge] Identity ready (UID=" + identity.getUid() + ")");
        return identity;
    }

    private static void saveIdentity(LocalIdentity identity) throws IOException {
        try (OutputStream out = Files.newOutputStream(IDENTITY_FILE)) {
            identity.save(out);
        }
    }

    // ========== TEMP CONNECTION FOR BOT QUERIES ==========

    /**
     * Send a message via a temporary connection using the user's identity.
     * Connects briefly, sends message, waits for bot response, disconnects.
     * Returns collected bot messages, or null on failure.
     */
    private static List<Map<String, Object>> sendViaTempConnection(int targetClid, String message) {
        if (userIdentity == null) return null;

        synchronized (tempConnLock) {
            LocalTeamspeakClientSocket tempClient = null;
            List<Map<String, Object>> collected = new CopyOnWriteArrayList<>();

            try {
                tempClient = new LocalTeamspeakClientSocket();
                tempClient.setIdentity(userIdentity);
                tempClient.setNickname(nickname); // Same as bridge, will get suffix if needed
                tempClient.setHWID("CrusaderBridgeTemp");

                final LocalTeamspeakClientSocket client = tempClient;
                String botUidEnv = System.getenv("BOT_UID");

                client.addListener(new TS3Listener() {
                    @Override
                    public void onTextMessage(TextMessageEvent e) {
                        try {
                            if (e.getInvokerId() == client.getClientId()) return;
                        } catch (Exception ignored) {}

                        Map<String, Object> msg = new LinkedHashMap<>();
                        msg.put("from_clid", e.getInvokerId());
                        msg.put("from_name", safe(e.getInvokerName()));
                        msg.put("from_uid", safe(e.getInvokerUniqueId()));
                        msg.put("message", safe(e.getMessage()));
                        msg.put("timestamp", System.currentTimeMillis() / 1000);
                        collected.add(msg);

                        // Also auto-learn bot clid
                        if (botUidEnv != null && botUidEnv.equals(safe(e.getInvokerUniqueId()))) {
                            lastKnownBotClid = e.getInvokerId();
                        }

                        log("[TempConn] MSG from " + e.getInvokerName() + ": " + safe(e.getMessage()));
                    }
                });

                log("[TempConn] Connecting with user identity to query bot...");
                client.connect(new InetSocketAddress(serverAddr, serverPort), null, 15000L);
                client.waitForState(ClientConnectionState.CONNECTED, 15000L);

                log("[TempConn] Connected (clid=" + client.getClientId() + "), moving to AFK...");
                moveToAfk(client);

                log("[TempConn] Sending to clid=" + targetClid);
                client.sendPrivateMessage(targetClid, message);

                // Wait for bot response (poll for up to 6 seconds)
                long deadline = System.currentTimeMillis() + 6000;
                int lastCount = 0;
                while (System.currentTimeMillis() < deadline) {
                    Thread.sleep(500);
                    // If we got messages and no new ones in last 1.5s, we're done
                    if (collected.size() > 0 && collected.size() == lastCount) break;
                    lastCount = collected.size();
                }

                log("[TempConn] Collected " + collected.size() + " messages, disconnecting");
                try { client.disconnect(); } catch (Exception ignored) {}

                // Add collected messages to the main incomingMessages so the dashboard can poll them
                incomingMessages.addAll(collected);

                return collected;

            } catch (Exception e) {
                log("[TempConn] Error: " + e.getMessage());
                if (tempClient != null) {
                    try { tempClient.disconnect(); } catch (Exception ignored) {}
                }
                return null;
            }
        }
    }

    /**
     * Check if a target clid is the bot (should use temp connection).
     */
    private static boolean isBotTarget(int targetClid) {
        String botClidEnv = System.getenv("BOT_CLID");
        if (botClidEnv != null) {
            try {
                if (Integer.parseInt(botClidEnv) == targetClid) return true;
            } catch (NumberFormatException ignored) {}
        }
        return lastKnownBotClid > 0 && targetClid == lastKnownBotClid;
    }

    // ========== MOVE TO AFK ==========

    /**
     * Find the AFK/hide channel. Checks AFK_CHANNEL_ID env first, then searches by name.
     * Returns -1 if not found.
     */
    private static int findAfkChannelId() {
        // 1. Check explicit env var
        String envCid = System.getenv("AFK_CHANNEL_ID");
        if (envCid != null && !envCid.isEmpty()) {
            try {
                return Integer.parseInt(envCid.trim());
            } catch (NumberFormatException e) {
                log("[Bridge] Invalid AFK_CHANNEL_ID: " + envCid);
            }
        }

        // 2. Search by name
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : channelCache.entrySet()) {
            String name = safe(entry.getValue().get("channel_name")).toLowerCase();
            if (name.contains("afk") || name.contains("away") || name.contains("deep web")) {
                return entry.getKey();
            }
        }
        return -1;
    }

    /**
     * Move a client to the AFK channel. Used for both main and temp connections.
     */
    private static void moveToAfk(LocalTeamspeakClientSocket client) {
        try {
            int afkCid = findAfkChannelId();
            if (afkCid > 0) {
                client.joinChannel(afkCid, null);
                log("[Bridge] Moved to AFK channel (cid=" + afkCid + ")");
            } else {
                log("[Bridge] AFK channel not found in cache");
            }
        } catch (Exception e) {
            log("[Bridge] Failed to move to AFK: " + e.getMessage());
        }
    }

    // ========== CHANNEL CACHE ==========

    private static void mergeChannelEvent(String source, int channelId, Map<String, String> update) {
        channelCache.compute(channelId, (_key, existing) -> {
            ConcurrentHashMap<String, String> merged = existing == null
                    ? new ConcurrentHashMap<>()
                    : new ConcurrentHashMap<>(existing);
            // ConcurrentHashMap doesn't allow null values, filter them out
            for (Map.Entry<String, String> entry : update.entrySet()) {
                if (entry.getKey() != null && entry.getValue() != null) {
                    merged.put(entry.getKey(), entry.getValue());
                }
            }
            return merged;
        });
    }

    // Lock for serialized command execution (prevents concurrent command conflicts)
    private static final Object commandLock = new Object();

    // Track if descriptions are being fetched to prevent concurrent fetches
    private static volatile boolean fetchingDescriptions = false;

    /**
     * Fetch a single channel's info via channelinfo command (serialized).
     * Must be called within a synchronized(commandLock) block or from a single thread.
     */
    private static void fetchChannelInfoSerialized(int channelId) {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;
        try {
            Channel info = tsClient.getChannelInfo(channelId);
            if (info != null) {
                Map<String, String> data = info.getMap();
                String desc = data.get("channel_description");
                int descLen = (desc != null) ? desc.length() : -1;
                // Only log channels with descriptions to avoid flooding the log buffer
                if (descLen > 0) {
                    log("[Desc] cid=" + channelId + " len=" + descLen);
                }
                mergeChannelEvent("channelinfo", channelId, data);
            }
        } catch (Exception ex) {
            log("[Desc] channelinfo cid=" + channelId + " failed: " + ex.getClass().getSimpleName() + ": " + ex.getMessage());
        }
    }

    /**
     * Fetch descriptions for all channels in the cache (serialized, one at a time).
     */
    private static void fetchAllDescriptions() {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;
        if (fetchingDescriptions) {
            log("[Bridge] fetchAllDescriptions skipped (already in progress)");
            return;
        }
        fetchingDescriptions = true;
        try {
            log("[Bridge] Fetching descriptions for " + channelCache.size() + " channels...");
            for (int cid : channelCache.keySet()) {
                synchronized (commandLock) {
                    fetchChannelInfoSerialized(cid);
                }
                // Small delay between commands to not overwhelm the server
                try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            }
            log("[Bridge] Description fetch complete");
        } finally {
            fetchingDescriptions = false;
        }
    }

    /**
     * Resolve a UID to a clid using the TS3 'clientgetids' command.
     * Unlike listClients(), this works for ALL client types including ServerQuery bots
     * that don't appear in the regular client list.
     * Returns -1 if not found.
     */
    private static int resolveUidToClid(String uid) {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return -1;
        try {
            synchronized (commandLock) {
                SingleCommand command = new SingleCommand(
                    "clientgetids",
                    ProtocolRole.CLIENT,
                    new CommandSingleParameter("cluid", uid)
                );
                Iterable<SingleCommand> results = tsClient.executeCommand(command).get();
                Iterator<SingleCommand> it = results.iterator();
                if (it.hasNext()) {
                    Map<String, String> map = it.next().toMap();
                    String clidStr = map.get("clid");
                    if (clidStr != null) {
                        int clid = Integer.parseInt(clidStr);
                        log("[Bridge] resolveUidToClid: " + uid + " -> clid=" + clid);
                        return clid;
                    }
                }
            }
        } catch (Exception ex) {
            log("[Bridge] resolveUidToClid failed for " + uid + ": " + ex.getMessage());
        }
        return -1;
    }

    /**
     * Periodic sync: refresh channel descriptions via channelinfo.
     * Channel names come from onChannelList events during initial connection.
     * listChannels() doesn't work reliably (named processor intercepts response).
     */
    private static void syncChannels() {
        fetchAllDescriptions();
    }

    /**
     * Sync client list from the server using listClients().
     */
    private static void syncClientList() {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;
        try {
            ConcurrentHashMap<Integer, ConcurrentHashMap<String, String>> fresh = new ConcurrentHashMap<>();
            int count = 0;
            for (Client cl : tsClient.listClients()) {
                count++;
                fresh.put(cl.getId(), new ConcurrentHashMap<>(cl.getMap()));
            }
            clientCache.clear();
            clientCache.putAll(fresh);
            System.out.println("[Bridge] Synced " + count + " clients into cache");
        } catch (Exception ex) {
            System.out.println("[Bridge] syncClientList failed: " + ex.getMessage());
        }
    }

    // ========== TS3 CONNECTION ==========

    private static void connectToTS3(LocalIdentity identity) {
        try {
            // Disconnect previous client if any
            if (tsClient != null) {
                try { tsClient.disconnect(); } catch (Exception ignored) {}
                tsClient = null;
                connected = false;
            }

            LocalTeamspeakClientSocket client = new LocalTeamspeakClientSocket();
            client.setIdentity(identity);
            client.setNickname(nickname);
            client.setHWID("CrusaderBridge");

            // Event listener for channel cache + messages
            client.addListener(new TS3Listener() {
                @Override
                public void onConnected(ConnectedEvent e) {
                    log("[Bridge] onConnected event received");
                    // Schedule initial sync after connection stabilizes
                    // syncChannelList already calls fetchAllDescriptions at the end
                    scheduler.schedule(() -> {
                        syncChannels();
                        syncClientList();
                    }, 3, TimeUnit.SECONDS);
                }

                @Override
                public void onChannelList(ChannelListEvent e) {
                    mergeChannelEvent("onChannelList", e.getChannelId(), e.getMap());
                }

                @Override
                public void onChannelEdit(ChannelEditedEvent e) {
                    mergeChannelEvent("onChannelEdit", e.getChannelId(), e.getMap());
                }

                @Override
                public void onChannelDescriptionChanged(ChannelDescriptionEditedEvent e) {
                    // Just mark that this channel's description changed (cid only, no content)
                    // Descriptions are fetched in batch during periodic sync
                    log("[Event] descChanged cid=" + e.getChannelId());
                }

                @Override
                public void onChannelCreate(ChannelCreateEvent e) {
                    mergeChannelEvent("onChannelCreate", e.getChannelId(), e.getMap());
                }

                @Override
                public void onChannelDeleted(ChannelDeletedEvent e) {
                    channelCache.remove(e.getChannelId());
                }

                @Override
                public void onClientJoin(ClientJoinEvent e) {
                    ConcurrentHashMap<String, String> data = new ConcurrentHashMap<>(e.getMap());
                    clientCache.put(e.getClientId(), data);
                }

                @Override
                public void onClientLeave(ClientLeaveEvent e) {
                    clientCache.remove(e.getClientId());
                }

                @Override
                public void onTextMessage(TextMessageEvent e) {
                    // Ignore own messages
                    try {
                        if (tsClient != null && e.getInvokerId() == tsClient.getClientId()) return;
                    } catch (Exception ignored) {}

                    Map<String, Object> msg = new LinkedHashMap<>();
                    msg.put("from_clid", e.getInvokerId());
                    msg.put("from_name", safe(e.getInvokerName()));
                    msg.put("from_uid", safe(e.getInvokerUniqueId()));
                    msg.put("message", safe(e.getMessage()));
                    msg.put("timestamp", System.currentTimeMillis() / 1000);

                    incomingMessages.add(msg);

                    // Auto-learn bot clid: if the message is from the BOT_UID, save its clid
                    String botUidEnv = System.getenv("BOT_UID");
                    if (botUidEnv != null && botUidEnv.equals(safe(e.getInvokerUniqueId()))) {
                        int oldClid = lastKnownBotClid;
                        lastKnownBotClid = e.getInvokerId();
                        if (oldClid != lastKnownBotClid) {
                            log("[Bridge] Auto-learned bot clid: " + lastKnownBotClid + " (was " + oldClid + ")");
                        }
                    }

                    // Keep max 100 messages
                    while (incomingMessages.size() > 100) {
                        incomingMessages.remove(0);
                    }

                    log("[Bridge] MSG from " + e.getInvokerName() + " (clid=" + e.getInvokerId() + " uid=" + safe(e.getInvokerUniqueId()) + "): " + safe(e.getMessage()));
                }

                @Override
                public void onDisconnected(DisconnectedEvent e) {
                    connected = false;
                    System.out.println("[Bridge] Disconnected from server");
                    scheduleReconnect(identity);
                }
            });

            System.out.println("[Bridge] Connecting to " + serverAddr + ":" + serverPort + "...");
            client.connect(
                new InetSocketAddress(serverAddr, serverPort),
                null,       // no password
                20000L      // 20 second timeout
            );
            client.waitForState(ClientConnectionState.CONNECTED, 20000L);

            // Subscribe to all channels so we receive description change events
            try {
                client.subscribeAll();
                System.out.println("[Bridge] Subscribed to all channels");
            } catch (Exception subEx) {
                System.out.println("[Bridge] subscribeAll failed: " + subEx.getMessage());
            }

            tsClient = client;
            connected = true;
            System.out.println("[Bridge] Connected! ClientID=" + client.getClientId());

            // Move to AFK channel after a delay (wait for channel cache to populate)
            scheduler.schedule(() -> moveToAfk(client), 5, TimeUnit.SECONDS);

        } catch (Exception e) {
            connected = false;
            System.err.println("[Bridge] Connection failed: " + e.getMessage());
            scheduleReconnect(identity);
        }
    }

    private static void scheduleReconnect(LocalIdentity identity) {
        scheduler.schedule(() -> {
            if (!connected) {
                System.out.println("[Bridge] Attempting reconnection...");
                connectToTS3(identity);
            }
        }, 5, TimeUnit.SECONDS);
    }

    private static void connectWithRetry(LocalIdentity identity) {
        connectToTS3(identity);

        // Periodic channel/client cache refresh
        scheduler.scheduleAtFixedRate(() -> {
            if (connected) {
                syncChannels();
                syncClientList();
            }
        }, 30, 30, TimeUnit.SECONDS);

        // Block main thread forever
        try {
            Thread.currentThread().join();
        } catch (InterruptedException e) {
            System.out.println("[Bridge] Main thread interrupted, exiting");
        }
    }

    private static String safe(String s) {
        return s != null ? s : "";
    }

    // ========== HTTP SERVER ==========

    private static void startHttpServer() throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", httpPort), 0);
        server.setExecutor(Executors.newFixedThreadPool(4));

        server.createContext("/api/status", TS3Bridge::handleStatus);
        server.createContext("/api/channels", TS3Bridge::handleChannels);
        server.createContext("/api/channel/", TS3Bridge::handleChannelDescription);
        server.createContext("/api/clients", TS3Bridge::handleClients);
        server.createContext("/api/client/uid/", TS3Bridge::handleClientByUid);
        server.createContext("/api/message", TS3Bridge::handleMessage);
        server.createContext("/api/messages", TS3Bridge::handleMessages);
        server.createContext("/api/debug/cache", TS3Bridge::handleDebugCache);
        server.createContext("/api/debug/logs", TS3Bridge::handleDebugLogs);
        server.createContext("/api/debug/resolve/", TS3Bridge::handleDebugResolve);

        server.start();
        System.out.println("[Bridge] HTTP API started on port " + httpPort);
    }

    // --- HTTP Helpers ---

    private static void addCorsHeaders(HttpExchange ex) {
        Headers h = ex.getResponseHeaders();
        h.set("Access-Control-Allow-Origin", "*");
        h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        h.set("Access-Control-Allow-Headers", "Content-Type");
    }

    private static void sendJson(HttpExchange ex, int code, Object data) throws IOException {
        addCorsHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        String json = gson.toJson(data);
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void sendText(HttpExchange ex, int code, String text) throws IOException {
        addCorsHeaders(ex);
        ex.getResponseHeaders().set("Content-Type", "text/plain; charset=utf-8");
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void handleOptions(HttpExchange ex) throws IOException {
        addCorsHeaders(ex);
        ex.sendResponseHeaders(204, -1);
    }

    private static Map<String, Object> jsonObj(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(ex.getRequestBody(), StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            return sb.toString();
        }
    }

    // ========== HANDLERS ==========

    /**
     * GET /api/status - Connection status and basic counts.
     */
    private static void handleStatus(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        Map<String, Object> status = new LinkedHashMap<>();
        status.put("connected", connected);
        status.put("server", serverAddr + ":" + serverPort);
        status.put("nickname", nickname);
        status.put("uid", identityUid);
        status.put("channels", channelCache.size());
        status.put("clients", clientCache.size());
        status.put("lastKnownBotClid", lastKnownBotClid);
        String botClidEnv = System.getenv("BOT_CLID");
        status.put("botClidEnv", botClidEnv != null ? botClidEnv : "not set");
        status.put("userIdentityLoaded", userIdentity != null);

        sendJson(ex, 200, status);
    }

    /**
     * GET /api/channels - List all channels from cache.
     */
    private static void handleChannels(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected) {
            sendJson(ex, 503, jsonObj("error", "Not connected"));
            return;
        }

        List<Map<String, Object>> channels = new ArrayList<>();
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : channelCache.entrySet()) {
            int cid = entry.getKey();
            Map<String, String> ch = entry.getValue();
            String name = safe(ch.get("channel_name"));
            String totalClientsStr = ch.getOrDefault("total_clients", "0");
            int totalClients;
            try {
                totalClients = Integer.parseInt(totalClientsStr);
            } catch (NumberFormatException e) {
                totalClients = 0;
            }

            channels.add(jsonObj(
                "cid", cid,
                "name", name,
                "total_clients", totalClients
            ));
        }
        sendJson(ex, 200, channels);
    }

    /**
     * GET /api/channel/{cid}/description - Get channel description from cache.
     */
    private static void handleChannelDescription(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected) {
            sendText(ex, 503, "Not connected");
            return;
        }

        String path = ex.getRequestURI().getPath();
        String[] parts = path.split("/");
        if (parts.length < 5) {
            sendText(ex, 400, "Invalid URL format. Use /api/channel/{cid}/description");
            return;
        }

        int cid;
        try {
            cid = Integer.parseInt(parts[3]);
        } catch (NumberFormatException e) {
            sendText(ex, 400, "Invalid channel ID");
            return;
        }

        ConcurrentHashMap<String, String> ch = channelCache.get(cid);
        if (ch == null) {
            sendText(ex, 404, "Channel not found in cache");
            return;
        }

        String desc = safe(ch.get("channel_description"));
        sendText(ex, 200, desc);
    }

    /**
     * GET /api/clients - List all connected clients from cache.
     * Falls back to listClients() if cache is empty.
     */
    private static void handleClients(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected || tsClient == null) {
            sendJson(ex, 503, jsonObj("error", "Not connected"));
            return;
        }

        // Try live listClients() first (it works on this server)
        try {
            List<Map<String, Object>> clients = new ArrayList<>();
            for (Client cl : tsClient.listClients()) {
                int clientType = cl.getInt("client_type");
                if (clientType == 1) continue;

                clients.add(jsonObj(
                    "clid", cl.getId(),
                    "cid", cl.getChannelId(),
                    "nickname", cl.getNickname(),
                    "client_type", clientType
                ));
            }
            sendJson(ex, 200, clients);
            return;
        } catch (Exception e) {
            System.out.println("[Bridge] listClients() failed, using cache: " + e.getMessage());
        }

        // Fallback to client cache
        List<Map<String, Object>> clients = new ArrayList<>();
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : clientCache.entrySet()) {
            int clid = entry.getKey();
            Map<String, String> cl = entry.getValue();
            String clientTypeStr = cl.getOrDefault("client_type", "0");
            int clientType;
            try {
                clientType = Integer.parseInt(clientTypeStr);
            } catch (NumberFormatException e) {
                clientType = 0;
            }
            if (clientType == 1) continue;

            int cidVal;
            try {
                cidVal = Integer.parseInt(cl.getOrDefault("cid", cl.getOrDefault("ctid", "0")));
            } catch (NumberFormatException e) {
                cidVal = 0;
            }

            clients.add(jsonObj(
                "clid", clid,
                "cid", cidVal,
                "nickname", safe(cl.get("client_nickname")),
                "client_type", clientType
            ));
        }
        sendJson(ex, 200, clients);
    }

    /**
     * GET /api/client/uid/{uid} - Find a client by unique identifier.
     */
    private static void handleClientByUid(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected || tsClient == null) {
            sendJson(ex, 503, jsonObj("error", "Not connected"));
            return;
        }

        String path = ex.getRequestURI().getPath();
        String prefix = "/api/client/uid/";
        if (path.length() <= prefix.length()) {
            sendJson(ex, 400, jsonObj("error", "Missing UID"));
            return;
        }
        String uid = java.net.URLDecoder.decode(path.substring(prefix.length()), StandardCharsets.UTF_8);

        // Try clientgetids first (works for ALL client types, including invisible bots)
        int resolvedClid = resolveUidToClid(uid);
        if (resolvedClid > 0) {
            sendJson(ex, 200, jsonObj(
                "clid", resolvedClid,
                "cid", 0,
                "nickname", "resolved-by-uid",
                "client_type", 0
            ));
            return;
        }

        // Try live listClients() as fallback
        try {
            for (Client cl : tsClient.listClients()) {
                String clientUid = cl.getUniqueIdentifier();
                if (uid.equals(clientUid)) {
                    sendJson(ex, 200, jsonObj(
                        "clid", cl.getId(),
                        "cid", cl.getChannelId(),
                        "nickname", cl.getNickname(),
                        "client_type", 0
                    ));
                    return;
                }
            }
        } catch (Exception e) {
            System.out.println("[Bridge] listClients() for UID lookup failed: " + e.getMessage());
        }

        // Fallback: search client cache
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : clientCache.entrySet()) {
            Map<String, String> cl = entry.getValue();
            String clientUid = cl.get("client_unique_identifier");
            if (uid.equals(clientUid)) {
                int cidVal;
                try {
                    cidVal = Integer.parseInt(cl.getOrDefault("cid", cl.getOrDefault("ctid", "0")));
                } catch (NumberFormatException e) {
                    cidVal = 0;
                }
                sendJson(ex, 200, jsonObj(
                    "clid", entry.getKey(),
                    "cid", cidVal,
                    "nickname", safe(cl.get("client_nickname")),
                    "client_type", 0
                ));
                return;
            }
        }

        sendJson(ex, 404, jsonObj("error", "Client not found"));
    }

    /**
     * POST /api/message - Send a private message to a client.
     * Body: {"target_clid": 123, "message": "hello"}
     *   OR: {"target_uid": "base64uid=", "message": "hello"}  (resolves UID -> clid via clientgetids)
     */
    @SuppressWarnings("unchecked")
    private static void handleMessage(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!"POST".equals(ex.getRequestMethod())) {
            sendJson(ex, 405, jsonObj("error", "Method not allowed. Use POST."));
            return;
        }

        if (!connected || tsClient == null) {
            sendJson(ex, 503, jsonObj("success", false, "error", "Not connected"));
            return;
        }

        String body = readBody(ex);
        log("[API] POST /api/message body=" + body);
        Map<String, Object> req;
        try {
            req = gson.fromJson(body, Map.class);
        } catch (Exception e) {
            sendJson(ex, 400, jsonObj("success", false, "error", "Invalid JSON"));
            return;
        }

        int targetClid;
        String message;
        try {
            message = (String) req.get("message");
            if (message == null || message.isEmpty()) throw new IllegalArgumentException("Missing message");

            // Support target_uid as alternative to target_clid (resolves UID -> clid internally)
            if (req.containsKey("target_uid")) {
                String targetUid = (String) req.get("target_uid");
                // Try dynamic resolution first
                targetClid = resolveUidToClid(targetUid);
                // Fallback: check clientCache for UID (from onClientJoin events)
                if (targetClid <= 0) {
                    for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : clientCache.entrySet()) {
                        String cuid = entry.getValue().get("client_unique_identifier");
                        if (targetUid.equals(cuid)) {
                            targetClid = entry.getKey();
                            log("[Bridge] Found target_uid in clientCache: clid=" + targetClid);
                            break;
                        }
                    }
                }
                // Fallback: BOT_CLID env var (static, for bots that don't appear in clientlist)
                if (targetClid <= 0) {
                    String botClidEnv = System.getenv("BOT_CLID");
                    if (botClidEnv != null && !botClidEnv.isEmpty()) {
                        try {
                            targetClid = Integer.parseInt(botClidEnv);
                            log("[Bridge] Using BOT_CLID env fallback: clid=" + targetClid);
                        } catch (NumberFormatException nfe) {
                            log("[Bridge] Invalid BOT_CLID env: " + botClidEnv);
                        }
                    }
                }
                // Fallback: lastKnownBotClid (from previous bot responses)
                if (targetClid <= 0 && lastKnownBotClid > 0) {
                    targetClid = lastKnownBotClid;
                    log("[Bridge] Using lastKnownBotClid: " + targetClid);
                }
                if (targetClid <= 0) {
                    log("[Bridge] Could not resolve target_uid: " + targetUid);
                    sendJson(ex, 404, jsonObj("success", false, "error",
                        "Could not resolve UID. Set BOT_CLID env var with the bot's client ID."));
                    return;
                }
                log("[Bridge] Resolved target_uid=" + targetUid + " -> clid=" + targetClid);
            } else {
                targetClid = ((Number) req.get("target_clid")).intValue();
            }
        } catch (Exception e) {
            sendJson(ex, 400, jsonObj("success", false, "error", "Missing target_clid/target_uid or message: " + e.getMessage()));
            return;
        }

        // If USER_IDENTITY is configured and target is the bot, use temp connection
        if (userIdentity != null && isBotTarget(targetClid)) {
            log("[Bridge] Bot target detected, using temp user identity connection");
            List<Map<String, Object>> result = sendViaTempConnection(targetClid, message);
            if (result != null) {
                sendJson(ex, 200, jsonObj("success", true, "method", "temp_connection", "messages_collected", result.size()));
                return;
            }
            log("[Bridge] Temp connection failed, falling back to main connection");
        }

        try {
            tsClient.sendPrivateMessage(targetClid, message);
            sendJson(ex, 200, jsonObj("success", true, "method", "main_connection"));
        } catch (Exception e) {
            sendJson(ex, 200, jsonObj("success", false, "error", e.getMessage()));
        }
    }

    /**
     * GET /api/messages - Get and consume incoming messages.
     */
    private static void handleMessages(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        List<Map<String, Object>> msgs = new ArrayList<>(incomingMessages);
        incomingMessages.clear();
        sendJson(ex, 200, msgs);
    }

    /**
     * GET /api/debug/logs - Return recent log lines.
     */
    private static void handleDebugLogs(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }
        sendJson(ex, 200, new ArrayList<>(logBuffer));
    }

    /**
     * GET /api/debug/resolve/{uid} - Test UID resolution (for debugging).
     */
    private static void handleDebugResolve(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }
        String path = ex.getRequestURI().getPath();
        String prefix = "/api/debug/resolve/";
        if (path.length() <= prefix.length()) {
            sendJson(ex, 400, jsonObj("error", "Missing UID"));
            return;
        }
        String uid = java.net.URLDecoder.decode(path.substring(prefix.length()), StandardCharsets.UTF_8);
        log("[Debug] resolve test for: " + uid);

        // Test multiple approaches to find the client
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("uid", uid);

        // Approach 1: clientgetids
        int clid1 = resolveUidToClid(uid);
        result.put("clientgetids_clid", clid1);

        // Approach 2: listClients with UID matching
        int clid2 = -1;
        String nickname2 = null;
        try {
            synchronized (commandLock) {
                for (com.github.manevolent.ts3j.api.Client cl : tsClient.listClients()) {
                    String cuid = cl.getUniqueIdentifier();
                    if (uid.equals(cuid)) {
                        clid2 = cl.getId();
                        nickname2 = cl.getNickname();
                        break;
                    }
                }
            }
        } catch (Exception ex2) {
            result.put("listClients_error", ex2.getMessage());
        }
        result.put("listClients_clid", clid2);
        result.put("listClients_nickname", nickname2);

        // Approach 3: clientfind by common bot names
        int clid3 = -1;
        try {
            synchronized (commandLock) {
                for (String pattern : new String[]{"CrusaderBot", "ExptoBotModify", "Crusader"}) {
                    try {
                        SingleCommand cmd = new SingleCommand("clientfind", ProtocolRole.CLIENT,
                            new CommandSingleParameter("pattern", pattern));
                        Iterable<SingleCommand> results2 = tsClient.executeCommand(cmd).get();
                        for (SingleCommand r : results2) {
                            Map<String, String> m = r.toMap();
                            log("[Debug] clientfind '" + pattern + "': " + m);
                            if (clid3 < 0 && m.get("clid") != null) {
                                clid3 = Integer.parseInt(m.get("clid"));
                            }
                        }
                    } catch (Exception ignored) {
                        log("[Debug] clientfind '" + pattern + "' failed: " + ignored.getMessage());
                    }
                    Thread.sleep(100);
                }
            }
        } catch (Exception ex3) {
            result.put("clientfind_error", ex3.getMessage());
        }
        result.put("clientfind_clid", clid3);

        // Approach 4: search clientCache (from onClientJoin events)
        int clid4 = -1;
        String nickname4 = null;
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : clientCache.entrySet()) {
            String cuid = entry.getValue().get("client_unique_identifier");
            if (uid.equals(cuid)) {
                clid4 = entry.getKey();
                nickname4 = entry.getValue().get("client_nickname");
                break;
            }
        }
        result.put("cache_clid", clid4);
        result.put("cache_nickname", nickname4);

        boolean found = clid1 > 0 || clid2 > 0 || clid3 > 0 || clid4 > 0;
        result.put("found", found);
        result.put("best_clid", clid1 > 0 ? clid1 : clid2 > 0 ? clid2 : clid3 > 0 ? clid3 : clid4);

        sendJson(ex, 200, result);
    }

    /**
     * GET /api/debug/cache - Dump raw channel cache for debugging.
     */
    private static void handleDebugCache(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("totalChannels", channelCache.size());
        result.put("totalClients", clientCache.size());
        result.put("connected", connected);

        Map<String, Object> channels = new LinkedHashMap<>();
        for (Map.Entry<Integer, ConcurrentHashMap<String, String>> entry : channelCache.entrySet()) {
            Map<String, String> ch = new LinkedHashMap<>(entry.getValue());
            channels.put(String.valueOf(entry.getKey()), ch);
        }
        result.put("channels", channels);
        sendJson(ex, 200, result);
    }
}
