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

import com.github.manevolent.ts3j.util.Ts3Debugging;

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
        while (logBuffer.size() > 200) logBuffer.remove(0);
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

        // Load or create TS3 identity
        LocalIdentity identity = loadIdentity();

        // Connect (blocks forever with reconnection)
        connectWithRetry(identity);
    }

    private static String env(String key, String defaultVal) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : defaultVal;
    }

    // ========== IDENTITY ==========

    private static LocalIdentity loadIdentity() throws IOException, GeneralSecurityException {
        if (Files.exists(IDENTITY_FILE)) {
            try (InputStream in = Files.newInputStream(IDENTITY_FILE)) {
                LocalIdentity identity = LocalIdentity.read(in);
                System.out.println("[Bridge] Loaded identity (level " + identity.getSecurityLevel() + ")");
                if (identity.getSecurityLevel() < IDENTITY_LEVEL) {
                    System.out.println("[Bridge] Improving security level to " + IDENTITY_LEVEL + "...");
                    identity.improveSecurity(IDENTITY_LEVEL);
                    saveIdentity(identity);
                }
                return identity;
            }
        }

        System.out.println("[Bridge] Generating new identity (security level " + IDENTITY_LEVEL + ")...");
        LocalIdentity identity = LocalIdentity.generateNew(IDENTITY_LEVEL);
        saveIdentity(identity);
        System.out.println("[Bridge] Identity ready");
        return identity;
    }

    private static void saveIdentity(LocalIdentity identity) throws IOException {
        try (OutputStream out = Files.newOutputStream(IDENTITY_FILE)) {
            identity.save(out);
        }
    }

    // ========== CHANNEL CACHE ==========

    private static void mergeChannelEvent(String source, int channelId, Map<String, String> update) {
        log("[Cache] " + source + " cid=" + channelId + " keys=" + update.keySet() + " vals=" + update);
        channelCache.compute(channelId, (_key, existing) -> {
            ConcurrentHashMap<String, String> merged = existing == null
                    ? new ConcurrentHashMap<>()
                    : new ConcurrentHashMap<>(existing);
            merged.putAll(update);
            return merged;
        });
    }

    /**
     * Fetch a single channel's description using raw command.
     * Tries "channelvariable" first (TS3 client protocol), then "channelinfo" (ServerQuery).
     */
    private static void fetchChannelDescription(int channelId) {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;

        // Try channelinfo (works on some servers, returns full channel data including description)
        try {
            Channel info = tsClient.getChannelInfo(channelId);
            if (info != null) {
                Map<String, String> data = info.getMap();
                log("[Desc] channelinfo cid=" + channelId + " keys=" + data.keySet());
                if (data.containsKey("channel_description")) {
                    mergeChannelEvent("channelinfo", channelId, data);
                    return;
                }
            }
        } catch (Exception ex) {
            log("[Desc] channelinfo cid=" + channelId + " failed: " + ex.getMessage());
        }

        // Try raw "channelvariable" command (TS3 client protocol for requesting specific properties)
        try {
            SingleCommand cmd = new SingleCommand(
                "channelvariable",
                ProtocolRole.CLIENT,
                new CommandSingleParameter("cid", Integer.toString(channelId)),
                new CommandSingleParameter("channel_description", "")
            );
            Iterable<SingleCommand> result = tsClient.executeCommand(cmd).get();
            for (SingleCommand sc : result) {
                Map<String, String> data = sc.toMap();
                log("[Desc] channelvariable cid=" + channelId + " keys=" + data.keySet() + " vals=" + data);
                mergeChannelEvent("channelvariable", channelId, data);
            }
        } catch (Exception ex) {
            log("[Desc] channelvariable cid=" + channelId + " failed: " + ex.getMessage());
        }
    }

    /**
     * Fetch descriptions for all channels in the cache.
     */
    private static void fetchAllDescriptions() {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;
        log("[Bridge] Fetching descriptions for " + channelCache.size() + " channels...");
        for (int cid : channelCache.keySet()) {
            ConcurrentHashMap<String, String> ch = channelCache.get(cid);
            // Only fetch if we don't already have a description
            String existingDesc = ch != null ? ch.get("channel_description") : null;
            if (existingDesc == null || existingDesc.isEmpty() || "null".equals(existingDesc)) {
                fetchChannelDescription(cid);
            }
        }
    }

    /**
     * Sync channel list from the server using listChannels().
     * Note: listChannels() may not work reliably because the "channellist" named
     * processor intercepts the response. The initial channel data comes from
     * onChannelList events during connection.
     */
    private static void syncChannelList() {
        if (tsClient == null || tsClient.getState() != ClientConnectionState.CONNECTED) return;
        try {
            int count = 0;
            for (Channel channel : tsClient.listChannels()) {
                count++;
                mergeChannelEvent("syncChannelList", channel.getId(), channel.getMap());
            }
            log("[Bridge] Synced " + count + " channels into cache");
        } catch (Exception ex) {
            log("[Bridge] syncChannelList failed: " + ex.getMessage());
        }
        // After syncing channel list, fetch descriptions
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
                    scheduler.schedule(() -> {
                        syncChannelList();
                        syncClientList();
                    }, 2, TimeUnit.SECONDS);
                    // Fetch descriptions after channel list is loaded (give extra time)
                    scheduler.schedule(() -> fetchAllDescriptions(), 5, TimeUnit.SECONDS);
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
                    mergeChannelEvent("onChannelDescChanged", e.getChannelId(), e.getMap());
                    // Try to fetch the actual description content
                    scheduler.schedule(() -> fetchChannelDescription(e.getChannelId()), 500, TimeUnit.MILLISECONDS);
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

                    // Keep max 100 messages
                    while (incomingMessages.size() > 100) {
                        incomingMessages.remove(0);
                    }

                    System.out.println("[Bridge] MSG from " + e.getInvokerName() + ": " + e.getMessage());
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
                syncChannelList();
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
        status.put("channels", channelCache.size());
        status.put("clients", clientCache.size());

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

        // Try live listClients() first
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
            targetClid = ((Number) req.get("target_clid")).intValue();
            message = (String) req.get("message");
        } catch (Exception e) {
            sendJson(ex, 400, jsonObj("success", false, "error", "Missing target_clid or message"));
            return;
        }

        try {
            tsClient.sendPrivateMessage(targetClid, message);
            sendJson(ex, 200, jsonObj("success", true));
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
