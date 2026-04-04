package com.crusaders.bridge;

import com.github.manevolent.ts3j.protocol.socket.client.LocalTeamspeakClientSocket;
import com.github.manevolent.ts3j.identity.LocalIdentity;
import com.github.manevolent.ts3j.event.TS3Listener;
import com.github.manevolent.ts3j.event.TextMessageEvent;
import com.github.manevolent.ts3j.event.DisconnectedEvent;
import com.github.manevolent.ts3j.api.Channel;
import com.github.manevolent.ts3j.api.Client;
import com.google.gson.Gson;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.Headers;

import java.io.*;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * TS3 Bridge - Connects to a TS3 server as a regular client using the
 * ts3j library (Java implementation of the TS3 voice protocol).
 *
 * Exposes an HTTP API so the Crusaders Respawn Monitor can query
 * channels, clients, descriptions, and send/receive messages
 * without needing a local TS3 desktop client or ServerQuery credentials.
 */
public class TS3Bridge {

    private static volatile LocalTeamspeakClientSocket tsClient;
    private static volatile boolean connected = false;
    private static final CopyOnWriteArrayList<Map<String, Object>> incomingMessages = new CopyOnWriteArrayList<>();
    private static final Gson gson = new Gson();

    // Configuration
    private static String serverAddr;
    private static int serverPort;
    private static String nickname;
    private static int httpPort;
    private static String identityFile;

    // ========== MAIN ==========

    public static void main(String[] args) throws Exception {
        serverAddr = env("TS_SERVER", "crusaders.expto.com.br");
        serverPort = Integer.parseInt(env("TS_SERVER_PORT", "9987"));
        nickname = env("TS_NICKNAME", "CrusaderBridge");
        httpPort = Integer.parseInt(env("BRIDGE_PORT", "8080"));
        identityFile = env("IDENTITY_FILE", "/data/identity.ini");

        System.out.println("============================================");
        System.out.println("  TS3 Bridge (ts3j - Java)");
        System.out.println("============================================");
        System.out.println("  Server:    " + serverAddr + ":" + serverPort);
        System.out.println("  Nickname:  " + nickname);
        System.out.println("  HTTP API:  0.0.0.0:" + httpPort);
        System.out.println("============================================");

        // Start HTTP server first (non-blocking) so /api/status is available immediately
        startHttpServer();

        // Load or create TS3 identity
        LocalIdentity identity = loadOrCreateIdentity();

        // Connect to TS3 + reconnection loop (blocks forever)
        connectWithRetry(identity);
    }

    private static String env(String key, String defaultVal) {
        String v = System.getenv(key);
        return (v != null && !v.isEmpty()) ? v : defaultVal;
    }

    // ========== IDENTITY ==========

    private static LocalIdentity loadOrCreateIdentity() throws Exception {
        File file = new File(identityFile);

        if (file.exists()) {
            try {
                LocalIdentity id = LocalIdentity.read(file);
                System.out.println("[Bridge] Loaded identity from " + file.getAbsolutePath());
                return id;
            } catch (Exception e) {
                System.err.println("[Bridge] Failed to load identity: " + e.getMessage());
            }
        }

        System.out.println("[Bridge] Generating new identity (security level 8)...");
        LocalIdentity id = LocalIdentity.generateNew(8);
        System.out.println("[Bridge] Identity ready");

        File parent = file.getParentFile();
        if (parent != null) parent.mkdirs();
        id.save(file, new HashMap<>());
        System.out.println("[Bridge] Saved identity to " + file.getAbsolutePath());

        return id;
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

            // Event listener
            client.addListener(new TS3Listener() {
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
                }
            });

            System.out.println("[Bridge] Connecting to " + serverAddr + ":" + serverPort + "...");
            client.connect(
                new InetSocketAddress(InetAddress.getByName(serverAddr), serverPort),
                "",       // no password
                10000L    // 10 second timeout
            );

            // Subscribe to all channels so we can see all clients and receive events
            client.subscribeAll();

            tsClient = client;
            connected = true;
            System.out.println("[Bridge] Connected! ClientID=" + client.getClientId());

        } catch (Exception e) {
            connected = false;
            System.err.println("[Bridge] Connection failed: " + e.getMessage());
        }
    }

    private static void connectWithRetry(LocalIdentity identity) {
        // Initial connection attempt
        connectToTS3(identity);

        // Reconnection scheduler
        ScheduledExecutorService sched = Executors.newScheduledThreadPool(1);
        sched.scheduleAtFixedRate(() -> {
            if (!connected) {
                System.out.println("[Bridge] Attempting reconnection...");
                connectToTS3(identity);
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

    /**
     * Helper to build JSON objects with mixed value types.
     */
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

        if (connected && tsClient != null) {
            try {
                int channelCount = 0;
                for (Channel ch : tsClient.listChannels()) channelCount++;
                int clientCount = 0;
                for (Client cl : tsClient.listClients()) clientCount++;
                status.put("channels", channelCount);
                status.put("clients", clientCount);
            } catch (Exception e) {
                status.put("channels", 0);
                status.put("clients", 0);
                status.put("error", e.getMessage());
            }
        } else {
            status.put("channels", 0);
            status.put("clients", 0);
        }

        sendJson(ex, 200, status);
    }

    /**
     * GET /api/channels - List all channels with name and client count.
     */
    private static void handleChannels(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected || tsClient == null) {
            sendJson(ex, 503, jsonObj("error", "Not connected"));
            return;
        }

        try {
            List<Map<String, Object>> channels = new ArrayList<>();
            for (Channel ch : tsClient.listChannels()) {
                channels.add(jsonObj(
                    "cid", ch.getId(),
                    "name", ch.getName(),
                    "total_clients", ch.getTotalClients(),
                    "description", ""  // Use /api/channel/{cid}/description for full desc
                ));
            }
            sendJson(ex, 200, channels);
        } catch (Exception e) {
            sendJson(ex, 500, jsonObj("error", e.getMessage()));
        }
    }

    /**
     * GET /api/channel/{cid}/description - Get channel description by ID.
     */
    private static void handleChannelDescription(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected || tsClient == null) {
            sendText(ex, 503, "Not connected");
            return;
        }

        // Parse CID from URL: /api/channel/123/description
        String path = ex.getRequestURI().getPath();
        String[] parts = path.split("/");
        // Expected: ["", "api", "channel", "123", "description"]
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

        try {
            Channel ch = tsClient.getChannelInfo(cid);
            if (ch == null) {
                sendText(ex, 404, "Channel not found");
                return;
            }
            // Access description from the underlying property map
            String desc = ch.get("channel_description");
            sendText(ex, 200, desc != null ? desc : "");
        } catch (Exception e) {
            sendText(ex, 500, "Error: " + e.getMessage());
        }
    }

    /**
     * GET /api/clients - List all connected clients (excludes serverquery bots).
     */
    private static void handleClients(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        if (!connected || tsClient == null) {
            sendJson(ex, 503, jsonObj("error", "Not connected"));
            return;
        }

        try {
            List<Map<String, Object>> clients = new ArrayList<>();
            for (Client cl : tsClient.listClients()) {
                // Skip serverquery clients (client_type=1)
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
        } catch (Exception e) {
            sendJson(ex, 500, jsonObj("error", e.getMessage()));
        }
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

        // Parse UID from URL: /api/client/uid/{uid}
        String path = ex.getRequestURI().getPath();
        String prefix = "/api/client/uid/";
        if (path.length() <= prefix.length()) {
            sendJson(ex, 400, jsonObj("error", "Missing UID"));
            return;
        }
        String uid = path.substring(prefix.length());

        try {
            // First pass: check listClients (might have UID directly)
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

            // Second pass: get detailed info for each client (clientinfo includes UID)
            List<Integer> clientIds = new ArrayList<>();
            for (Client cl : tsClient.listClients()) {
                clientIds.add(cl.getId());
            }

            for (int clid : clientIds) {
                try {
                    Client info = tsClient.getClientInfo(clid);
                    if (info != null && uid.equals(info.getUniqueIdentifier())) {
                        sendJson(ex, 200, jsonObj(
                            "clid", info.getId(),
                            "cid", info.getChannelId(),
                            "nickname", info.getNickname(),
                            "client_type", 0
                        ));
                        return;
                    }
                } catch (Exception ignored) {
                    // Client may have disconnected between list and info calls
                }
            }

            sendJson(ex, 404, jsonObj("error", "Client not found"));
        } catch (Exception e) {
            sendJson(ex, 500, jsonObj("error", e.getMessage()));
        }
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
     * Messages are cleared after being read (consumed).
     */
    private static void handleMessages(HttpExchange ex) throws IOException {
        if ("OPTIONS".equals(ex.getRequestMethod())) { handleOptions(ex); return; }

        List<Map<String, Object>> msgs = new ArrayList<>(incomingMessages);
        incomingMessages.clear();
        sendJson(ex, 200, msgs);
    }
}
