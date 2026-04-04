/**
 * Crusaders Respawn Monitor - TS3 Plugin
 *
 * Native TeamSpeak 3 plugin that:
 * 1. Captures bot messages (CrusaderBot responses)
 * 2. Polls the dashboard for pending bot queries
 * 3. Sends !respinfo commands to the bot
 * 4. Pushes results to the dashboard
 *
 * Communication with dashboard is authenticated via PLUGIN_SECRET.
 */

#ifdef _WIN32
#define _CRT_SECURE_NO_WARNINGS
#pragma comment(lib, "winhttp.lib")
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#else
#error "This plugin is Windows-only"
#endif

#include "ts3_functions.h"
#include "teamspeak/public_definitions.h"
#include "plugin_definitions.h"

/* --- Plugin info --- */
#define PLUGIN_API_VERSION 22
#define PLUGIN_NAME "Crusaders Monitor"
#define PLUGIN_VERSION "1.0.0"
#define PLUGIN_AUTHOR "Crusaders"
#define PLUGIN_DESCRIPTION "Connects to the Crusaders Respawn Monitor dashboard for bot queries"

/* --- Config --- */
#define DASHBOARD_HOST L"ts3.marcelod.com.br"
#define DASHBOARD_PORT 443
#define PLUGIN_SECRET "crusaders2026"
#define BOT_UID "JtyuT0YIadDhysblVvprGK/0Ces="
#define POLL_INTERVAL_MS 5000
#define MAX_MSG_LEN 4096
#define MAX_COLLECTED 20

/* --- Globals --- */
static struct TS3Functions ts3;
static char pluginID[128];
static HANDLE pollThread = NULL;
static volatile int running = 0;

/* Collected bot messages buffer */
static char collectedMessages[MAX_COLLECTED][MAX_MSG_LEN];
static int collectedCount = 0;
static char pendingCode[64] = {0};     /* Code we're currently querying */
static volatile int waitingForBot = 0; /* Are we waiting for bot response? */
static DWORD waitStartTime = 0;
static CRITICAL_SECTION msgLock;

/* --- Logging helper --- */
static void pluginLog(const char* msg) {
    ts3.logMessage(msg, LogLevel_INFO, PLUGIN_NAME, 0);
}

static void pluginLogFmt(const char* fmt, ...) {
    char buf[1024];
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    pluginLog(buf);
}

/* --- WinHTTP helper --- */

typedef struct {
    char* data;
    int len;
    int statusCode;
} HttpResponse;

static HttpResponse httpRequest(const wchar_t* host, int port, const wchar_t* verb,
                                 const wchar_t* path, const char* body, int bodyLen) {
    HttpResponse resp = {NULL, 0, 0};

    HINTERNET hSession = WinHttpOpen(L"CrusadersPlugin/1.0",
        WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return resp;

    HINTERNET hConnect = WinHttpConnect(hSession, host, port, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return resp; }

    DWORD flags = (port == 443) ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, verb, path, NULL,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return resp; }

    /* Add auth header */
    wchar_t authHeader[256];
    swprintf(authHeader, 256, L"Authorization: Bearer %hs", PLUGIN_SECRET);
    WinHttpAddRequestHeaders(hRequest, authHeader, -1, WINHTTP_ADDREQ_FLAG_ADD);

    if (body && bodyLen > 0) {
        WinHttpAddRequestHeaders(hRequest, L"Content-Type: application/json", -1, WINHTTP_ADDREQ_FLAG_ADD);
    }

    BOOL bResult = WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
        (LPVOID)body, bodyLen, bodyLen, 0);

    if (bResult) bResult = WinHttpReceiveResponse(hRequest, NULL);

    if (bResult) {
        DWORD statusCode = 0, size = sizeof(DWORD);
        WinHttpQueryHeaders(hRequest, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &size, WINHTTP_NO_HEADER_INDEX);
        resp.statusCode = (int)statusCode;

        /* Read response body */
        char* result = NULL;
        int totalLen = 0;
        DWORD downloaded = 0;
        DWORD available = 0;

        while (WinHttpQueryDataAvailable(hRequest, &available) && available > 0) {
            char* tmp = realloc(result, totalLen + available + 1);
            if (!tmp) { free(result); result = NULL; break; }
            result = tmp;
            WinHttpReadData(hRequest, result + totalLen, available, &downloaded);
            totalLen += downloaded;
        }

        if (result) {
            result[totalLen] = '\0';
            resp.data = result;
            resp.len = totalLen;
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return resp;
}

static void freeHttpResponse(HttpResponse* resp) {
    if (resp->data) { free(resp->data); resp->data = NULL; }
    resp->len = 0;
}

/* --- Find bot clid by UID on current server --- */
static anyID findBotClid(uint64 schID) {
    anyID* clientList = NULL;
    if (ts3.getClientList(schID, &clientList) != 0 || !clientList) return 0;

    anyID botClid = 0;
    for (int i = 0; clientList[i] != 0; i++) {
        char* uid = NULL;
        if (ts3.getClientVariableAsString(schID, clientList[i], CLIENT_UNIQUE_IDENTIFIER, &uid) == 0 && uid) {
            if (strcmp(uid, BOT_UID) == 0) {
                botClid = clientList[i];
            }
            ts3.freeMemory(uid);
            if (botClid) break;
        }
    }
    ts3.freeMemory(clientList);
    return botClid;
}

/* --- Get first active server connection handler --- */
static uint64 getActiveSchID(void) {
    uint64* list = NULL;
    if (ts3.getServerConnectionHandlerList(&list) != 0 || !list) return 0;
    uint64 schID = list[0]; /* First connection */
    ts3.freeMemory(list);
    return schID;
}

/* --- Simple JSON string escaper --- */
static void jsonEscape(const char* src, char* dst, int dstSize) {
    int j = 0;
    for (int i = 0; src[i] && j < dstSize - 2; i++) {
        char c = src[i];
        if (c == '"' || c == '\\') { dst[j++] = '\\'; }
        else if (c == '\n') { dst[j++] = '\\'; dst[j++] = 'n'; continue; }
        else if (c == '\r') continue;
        else if (c == '\t') { dst[j++] = '\\'; dst[j++] = 't'; continue; }
        dst[j++] = c;
    }
    dst[j] = '\0';
}

/* --- Build JSON payload from collected messages --- */
static char* buildRespInfoPayload(const char* code) {
    /* Build raw messages JSON array */
    char rawMsgs[MAX_COLLECTED * MAX_MSG_LEN * 2];
    int offset = 0;
    offset += snprintf(rawMsgs + offset, sizeof(rawMsgs) - offset, "[");

    EnterCriticalSection(&msgLock);
    for (int i = 0; i < collectedCount; i++) {
        char escaped[MAX_MSG_LEN * 2];
        jsonEscape(collectedMessages[i], escaped, sizeof(escaped));
        if (i > 0) offset += snprintf(rawMsgs + offset, sizeof(rawMsgs) - offset, ",");
        offset += snprintf(rawMsgs + offset, sizeof(rawMsgs) - offset, "\"%s\"", escaped);
    }
    LeaveCriticalSection(&msgLock);
    offset += snprintf(rawMsgs + offset, sizeof(rawMsgs) - offset, "]");

    /* Full payload: just send rawMessages, dashboard will parse */
    size_t payloadSize = strlen(code) + strlen(rawMsgs) + 256;
    char* payload = malloc(payloadSize);
    if (!payload) return NULL;

    snprintf(payload, payloadSize,
        "{\"code\":\"%s\",\"rawMessages\":%s}", code, rawMsgs);
    return payload;
}

/* --- Poll dashboard and process queries --- */
static void pollDashboard(void) {
    uint64 schID = getActiveSchID();
    if (!schID) return;

    /* GET /api/plugin/poll */
    HttpResponse resp = httpRequest(DASHBOARD_HOST, DASHBOARD_PORT, L"GET",
        L"/api/plugin/poll", NULL, 0);

    if (resp.statusCode != 200 || !resp.data) {
        freeHttpResponse(&resp);
        return;
    }

    /* Simple JSON parse: find "pending":[...] array */
    /* Expected: {"pending":[{"code":"JR","nexts":2,"remainingMin":30},...]} */
    char* pendingStart = strstr(resp.data, "\"pending\":");
    if (!pendingStart) { freeHttpResponse(&resp); return; }

    char* arrStart = strchr(pendingStart, '[');
    if (!arrStart || arrStart[1] == ']') { freeHttpResponse(&resp); return; }

    /* Parse each pending item: find "code":"..." */
    char* pos = arrStart;
    while (pos) {
        char* codeKey = strstr(pos, "\"code\":\"");
        if (!codeKey) break;
        codeKey += 8; /* skip "code":" */
        char* codeEnd = strchr(codeKey, '"');
        if (!codeEnd) break;

        char code[64];
        int codeLen = (int)(codeEnd - codeKey);
        if (codeLen >= 64) codeLen = 63;
        strncpy(code, codeKey, codeLen);
        code[codeLen] = '\0';

        /* Find bot and send query */
        anyID botClid = findBotClid(schID);
        if (botClid == 0) {
            pluginLog("Bot not found on server");
            break;
        }

        pluginLogFmt("Querying bot for !respinfo %s (clid=%d)", code, botClid);

        /* Clear collected messages */
        EnterCriticalSection(&msgLock);
        collectedCount = 0;
        strncpy(pendingCode, code, sizeof(pendingCode) - 1);
        waitingForBot = 1;
        waitStartTime = GetTickCount();
        LeaveCriticalSection(&msgLock);

        /* Send !respinfo command */
        char msg[128];
        snprintf(msg, sizeof(msg), "!respinfo %s", code);
        unsigned int err = ts3.requestSendPrivateTextMsg(schID, msg, botClid, NULL);
        if (err != 0) {
            pluginLogFmt("Failed to send message to bot: error %u", err);
            waitingForBot = 0;
            pos = codeEnd + 1;
            continue;
        }

        /* Wait for bot responses (up to 6 seconds) */
        for (int i = 0; i < 12; i++) {
            Sleep(500);
            EnterCriticalSection(&msgLock);
            int count = collectedCount;
            LeaveCriticalSection(&msgLock);

            /* If we got messages and a half-second passed with no new ones, we're done */
            if (count > 0 && i > 2) {
                Sleep(500);
                EnterCriticalSection(&msgLock);
                int newCount = collectedCount;
                LeaveCriticalSection(&msgLock);
                if (newCount == count) break;
            }
        }

        waitingForBot = 0;

        EnterCriticalSection(&msgLock);
        int finalCount = collectedCount;
        LeaveCriticalSection(&msgLock);

        if (finalCount > 0) {
            pluginLogFmt("Got %d messages from bot for %s", finalCount, code);

            /* Build and send payload to dashboard */
            char* payload = buildRespInfoPayload(code);
            if (payload) {
                HttpResponse pushResp = httpRequest(DASHBOARD_HOST, DASHBOARD_PORT, L"POST",
                    L"/api/plugin/respinfo", payload, (int)strlen(payload));
                if (pushResp.statusCode == 200) {
                    pluginLogFmt("Pushed respinfo for %s to dashboard", code);
                } else {
                    pluginLogFmt("Failed to push respinfo: HTTP %d", pushResp.statusCode);
                }
                freeHttpResponse(&pushResp);
                free(payload);
            }
        } else {
            pluginLogFmt("No response from bot for %s", code);
        }

        /* Move to next item */
        pos = codeEnd + 1;

        /* Delay between queries */
        Sleep(1500);
    }

    freeHttpResponse(&resp);
}

/* --- Background poll thread --- */
static DWORD WINAPI pollThreadProc(LPVOID param) {
    (void)param;
    pluginLog("Poll thread started");

    while (running) {
        pollDashboard();

        /* Wait POLL_INTERVAL_MS but check running flag every 500ms */
        for (int i = 0; i < POLL_INTERVAL_MS / 500 && running; i++) {
            Sleep(500);
        }
    }

    pluginLog("Poll thread stopped");
    return 0;
}

/* ============================== */
/*     TS3 Plugin API exports     */
/* ============================== */

__declspec(dllexport) const char* ts3plugin_name(void) { return PLUGIN_NAME; }
__declspec(dllexport) const char* ts3plugin_version(void) { return PLUGIN_VERSION; }
__declspec(dllexport) int ts3plugin_apiVersion(void) { return PLUGIN_API_VERSION; }
__declspec(dllexport) const char* ts3plugin_author(void) { return PLUGIN_AUTHOR; }
__declspec(dllexport) const char* ts3plugin_description(void) { return PLUGIN_DESCRIPTION; }

__declspec(dllexport) void ts3plugin_setFunctionPointers(const struct TS3Functions funcs) {
    ts3 = funcs;
}

__declspec(dllexport) int ts3plugin_init(void) {
    InitializeCriticalSection(&msgLock);
    pluginLog("Crusaders Monitor plugin loaded");
    pluginLogFmt("Dashboard: %ls:%d", DASHBOARD_HOST, DASHBOARD_PORT);

    /* Start background poll thread */
    running = 1;
    pollThread = CreateThread(NULL, 0, pollThreadProc, NULL, 0, NULL);
    if (!pollThread) {
        pluginLog("ERROR: Failed to start poll thread");
        return 1; /* error */
    }

    return 0; /* success */
}

__declspec(dllexport) void ts3plugin_shutdown(void) {
    pluginLog("Shutting down...");

    running = 0;
    if (pollThread) {
        WaitForSingleObject(pollThread, 10000);
        CloseHandle(pollThread);
        pollThread = NULL;
    }

    DeleteCriticalSection(&msgLock);
    pluginLog("Crusaders Monitor plugin unloaded");
}

__declspec(dllexport) int ts3plugin_offersConfigure(void) {
    return PLUGIN_OFFERS_NO_CONFIGURE;
}

__declspec(dllexport) void ts3plugin_registerPluginID(const char* id) {
    strncpy(pluginID, id, sizeof(pluginID) - 1);
}

/**
 * Called when connection status changes.
 * Auto-mutes microphone when connecting to any server.
 */
__declspec(dllexport) void ts3plugin_onConnectStatusChangeEvent(
    uint64 serverConnectionHandlerID,
    int newStatus,
    unsigned int errorNumber
) {
    (void)errorNumber;
    if (newStatus == STATUS_CONNECTION_ESTABLISHED) {
        ts3.setClientSelfVariableAsInt(serverConnectionHandlerID, CLIENT_INPUT_MUTED, 1);
        ts3.flushClientSelfUpdates(serverConnectionHandlerID, NULL);
        pluginLog("Auto-muted microphone on connect");
    }
}

/**
 * Called when a text message is received.
 * We capture messages from CrusaderBot (matched by UID).
 */
__declspec(dllexport) int ts3plugin_onTextMessageEvent(
    uint64 serverConnectionHandlerID,
    anyID targetMode,
    anyID toID,
    anyID fromID,
    const char* fromName,
    const char* fromUniqueIdentifier,
    const char* message,
    int ffIgnored
) {
    (void)serverConnectionHandlerID;
    (void)targetMode;
    (void)toID;
    (void)fromID;
    (void)fromName;
    (void)ffIgnored;

    /* Only capture if we're waiting for bot response */
    if (!waitingForBot) return 0;

    /* Check if message is from the bot */
    if (fromUniqueIdentifier && strcmp(fromUniqueIdentifier, BOT_UID) == 0) {
        EnterCriticalSection(&msgLock);
        if (collectedCount < MAX_COLLECTED && message) {
            strncpy(collectedMessages[collectedCount], message, MAX_MSG_LEN - 1);
            collectedMessages[collectedCount][MAX_MSG_LEN - 1] = '\0';
            collectedCount++;
        }
        LeaveCriticalSection(&msgLock);
    }

    return 0; /* 0 = let TS3 handle the message normally */
}
