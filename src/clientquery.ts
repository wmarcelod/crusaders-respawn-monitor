/**
 * TeamSpeak connection layer.
 *
 * Supports two modes:
 * - ClientQuery (local, port 25639): connects to local TS3 desktop client
 * - ServerQuery (remote, port 10011): connects directly to TS server
 *
 * A global semaphore ensures only ONE connection at a time to avoid
 * hitting the TS max connections limit (error 515).
 */

import net from "net";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// --- Configuration ---

type TSMode = "clientquery" | "serverquery" | "bridge";

function getMode(): TSMode {
  const mode = (process.env.TS_MODE || "clientquery").toLowerCase();
  if (mode === "bridge") return "bridge";
  if (mode === "serverquery" || mode === "sq") return "serverquery";
  return "clientquery";
}

function getBridgeUrl(): string {
  return process.env.BRIDGE_URL || "http://ts3bridge:8080";
}

/**
 * Simple HTTP fetch for bridge mode (no external dependencies).
 */
async function bridgeFetch(path: string, method = "GET", body?: string): Promise<string> {
  const url = getBridgeUrl() + path;
  const http = await import("http");
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Bridge HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Bridge request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

function getHost(): string {
  return process.env.TS_HOST || "127.0.0.1";
}

function getPort(): number {
  const mode = getMode();
  if (mode === "serverquery") return parseInt(process.env.TS_QUERY_PORT || "10011");
  return parseInt(process.env.TS_QUERY_PORT || "25639");
}

function getAuthCommands(): string[] {
  const mode = getMode();
  if (mode === "serverquery") {
    const user = process.env.TS_QUERY_USER || "serveradmin";
    const pass = process.env.TS_QUERY_PASS || "";
    const sid = process.env.TS_VIRTUAL_SERVER || "1";
    return [
      `login ${user} ${pass}`,
      `use sid=${sid}`,
    ];
  }
  // ClientQuery - try shared volume key first, then env var
  let apiKey = process.env.TS_APIKEY || "";
  try {
    const sharedKey = fs.readFileSync("/shared/cq_apikey.txt", "utf-8").trim();
    if (sharedKey) apiKey = sharedKey;
  } catch { /* shared volume not available */ }
  return [`auth apikey=${apiKey}`];
}

// --- Global connection semaphore (max 1 concurrent connection) ---

let semaphoreQueue: Array<() => void> = [];
let semaphoreLocked = false;

export function acquireSemaphore(): Promise<void> {
  if (!semaphoreLocked) {
    semaphoreLocked = true;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    semaphoreQueue.push(resolve);
  });
}

export function releaseSemaphore(): void {
  if (semaphoreQueue.length > 0) {
    const next = semaphoreQueue.shift()!;
    next();
  } else {
    semaphoreLocked = false;
  }
}

// --- Interfaces ---

export interface ClientQueryOptions {
  apiKey?: string; // kept for backward compat, but auth comes from env
  timeout?: number;
}

export interface TSClient {
  clid: number;
  cid: number;
  nickname: string;
  clientType: number; // 0 = normal, 1 = serverquery
}

// --- Core: run commands ---

/**
 * Connects to TS (ClientQuery or ServerQuery), authenticates, runs commands, returns raw output.
 * Uses a global semaphore so only ONE connection exists at a time.
 */
export async function runCommands(
  commands: string[],
  opts?: ClientQueryOptions
): Promise<string> {
  await acquireSemaphore();

  try {
    return await _runCommandsInternal(commands, opts?.timeout || 10000);
  } finally {
    releaseSemaphore();
  }
}

function _runCommandsInternal(commands: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    client.setTimeout(timeout);
    let settled = false;

    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    let errorResponseCount = 0;

    const mode = getMode();
    const authCmds = getAuthCommands();
    const allCmds = [...authCmds, ...commands, "quit"];

    function done(err?: Error) {
      if (settled) return;
      settled = true;
      client.destroy();
      if (err) reject(err);
      else resolve(fullData);
    }

    function trySendNext() {
      if (cmdIdx < allCmds.length) {
        client.write(allCmds[cmdIdx++] + "\r\n");
      }
    }

    function countErrors(data: string): number {
      let count = 0;
      let idx = 0;
      while ((idx = data.indexOf("error id=", idx)) !== -1) {
        count++;
        idx += 9;
      }
      return count;
    }

    const host = getHost();
    const port = getPort();

    client.connect(port, host, () => {});

    client.on("data", (chunk) => {
      fullData += chunk.toString();

      // Detect max clients limit
      if (fullData.includes("id=515") || fullData.includes("max\\sclients\\sprotocol\\slimit")) {
        done(new Error("TS max connections limit reached (id=515). Restart TS client or wait."));
        return;
      }

      // Detect auth failures
      if (fullData.includes("id=520") || fullData.includes("id=256")) {
        done(new Error("TS authentication failed. Check credentials."));
        return;
      }

      // Wait for welcome message before sending first command
      // ClientQuery: "selected schandlerid=1"
      // ServerQuery: "Welcome to the TeamSpeak 3 ServerQuery interface"
      if (!ready) {
        const isReady = mode === "serverquery"
          ? fullData.includes("ServerQuery") || fullData.includes("TS3")
          : fullData.includes("selected");
        if (isReady) {
          ready = true;
          trySendNext();
        }
        return;
      }

      // Count "error id=" markers to know when each command response is complete
      const newCount = countErrors(fullData);
      while (errorResponseCount < newCount) {
        errorResponseCount++;
        trySendNext();
      }
    });

    client.on("close", () => done());
    client.on("error", (err) => done(err));
    client.on("timeout", () => done(new Error("TS connection timeout")));
  });
}

// --- Helpers ---

/**
 * Decode TeamSpeak escape sequences
 */
export function decodeTSString(str: string): string {
  return str
    .replace(/\\s/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\p/g, "|")
    .replace(/\\\//g, "/");
}

export function encodeTSString(str: string): string {
  return str
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\//g, "\\/");
}

/**
 * Get the description of a specific channel.
 * Uses `channelinfo` for ServerQuery, `channelvariable` for ClientQuery,
 * or the bridge HTTP API.
 */
export async function getChannelDescription(
  cid: number,
  apiKey?: string
): Promise<string> {
  const mode = getMode();

  // Bridge mode: HTTP call
  if (mode === "bridge") {
    return await bridgeFetch(`/api/channel/${cid}/description`);
  }

  // ServerQuery uses channelinfo, ClientQuery uses channelvariable
  const cmd = mode === "serverquery"
    ? `channelinfo cid=${cid}`
    : `channelvariable cid=${cid} channel_description`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await runCommands([cmd]);

    const lines = raw.split("\n");
    for (const line of lines) {
      const idx = line.indexOf("channel_description=");
      if (idx >= 0) {
        const value = line.substring(idx + "channel_description=".length).trim();
        // For ServerQuery, the value may continue until the next key (space-separated)
        // but channel_description is usually the last or only key with long content
        return decodeTSString(value.split(/\s+channel_\w+=/)[0] || value);
      }
    }

    // Check empty description (ClientQuery returns key without =)
    for (const line of lines) {
      if (line.includes("channel_description") && !line.includes("channel_description=")) {
        return "";
      }
    }

    if (attempt === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Could not get description for channel ${cid}`);
}

/**
 * Get the channel list
 */
export async function getChannelList(
  apiKey?: string
): Promise<Array<{ cid: number; name: string; clients: number }>> {
  const mode = getMode();

  // Bridge mode: HTTP call
  if (mode === "bridge") {
    const raw = await bridgeFetch("/api/channels");
    const channels = JSON.parse(raw) as Array<{ cid: number; name: string; total_clients: number }>;
    return channels.map(ch => ({
      cid: ch.cid,
      name: ch.name,
      clients: ch.total_clients,
    }));
  }

  const raw = await runCommands(["channellist"]);

  const lines = raw.split("\n");
  let channelLine = "";
  for (const line of lines) {
    if (line.startsWith("cid=") || line.includes("|cid=")) {
      channelLine = line.trim();
      break;
    }
  }

  if (!channelLine) return [];

  const entries = channelLine.split("|");
  return entries.map((entry) => {
    const cidMatch = entry.match(/cid=(\d+)/);
    const nameMatch = entry.match(/channel_name=(.+?)(?:\s+channel_flag|\s+total_clients|\s+channel_|\s*$)/);
    const clientsMatch = entry.match(/total_clients=(\d+)/);

    return {
      cid: parseInt(cidMatch?.[1] || "0"),
      name: decodeTSString(nameMatch?.[1]?.trim() || "?"),
      clients: parseInt(clientsMatch?.[1] || "0"),
    };
  });
}

/**
 * Find the Respawn List channel
 */
export async function findRespawnListChannel(
  apiKey?: string
): Promise<{ cid: number; name: string; count: number } | null> {
  const channels = await getChannelList();
  const respawnCh = channels.find(
    (ch) =>
      ch.name.includes("Respawn List") &&
      !ch.name.includes("Respawn Number")
  );

  if (!respawnCh) return null;

  const countMatch = respawnCh.name.match(/\((\d+)\)/);
  return {
    cid: respawnCh.cid,
    name: respawnCh.name,
    count: parseInt(countMatch?.[1] || "0"),
  };
}

/**
 * Find the Respawn Number channel (catalog)
 */
export async function findRespawnNumberChannel(
  apiKey?: string
): Promise<{ cid: number; name: string; count: number } | null> {
  const channels = await getChannelList();
  const ch = channels.find((c) => c.name.includes("Respawn Number"));

  if (!ch) return null;

  const countMatch = ch.name.match(/\((\d+)\)/);
  return {
    cid: ch.cid,
    name: ch.name,
    count: parseInt(countMatch?.[1] || "0"),
  };
}

/**
 * Get all connected clients.
 * Filters out serverquery bots (client_type=1).
 */
export async function getAllClients(apiKey?: string): Promise<TSClient[]> {
  const mode = getMode();

  // Bridge mode: HTTP call
  if (mode === "bridge") {
    const raw = await bridgeFetch("/api/clients");
    const clients = JSON.parse(raw) as Array<{ clid: number; cid: number; nickname: string; client_type: number }>;
    return clients
      .filter(c => {
        if (!c.nickname || c.nickname === "Unknown" || c.nickname === "undefined") return false;
        const bridgeNick = (process.env.BRIDGE_NICKNAME || "").toLowerCase();
        if (bridgeNick && c.nickname.toLowerCase() === bridgeNick) return false;
        return true;
      })
      .map(c => ({
        clid: c.clid,
        cid: c.cid,
        nickname: c.nickname,
        clientType: c.client_type,
      }));
  }

  const raw = await runCommands(["clientlist"]);

  const lines = raw.split("\n");
  let clientLine = "";
  for (const line of lines) {
    if (line.startsWith("clid=") || line.includes("|clid=")) {
      clientLine = line.trim();
      break;
    }
  }

  if (!clientLine) return [];

  const entries = clientLine.split("|");
  const clients: TSClient[] = [];

  for (const entry of entries) {
    const clidMatch = entry.match(/clid=(\d+)/);
    const cidMatch = entry.match(/\bcid=(\d+)/);
    const nicknameMatch = entry.match(/client_nickname=(\S+)/);
    const typeMatch = entry.match(/client_type=(\d+)/);

    const clientType = parseInt(typeMatch?.[1] || "0");
    if (clientType === 1) continue;

    const nickname = decodeTSString(nicknameMatch?.[1]?.trim() || "");
    if (!nickname || nickname === "Unknown" || nickname === "undefined") continue;

    clients.push({
      clid: parseInt(clidMatch?.[1] || "0"),
      cid: parseInt(cidMatch?.[1] || "0"),
      nickname,
      clientType,
    });
  }

  return clients;
}

/**
 * Send a text message to a specific client (private message).
 * Used for bot communication.
 */
export async function sendTextMessage(
  targetClid: number,
  message: string
): Promise<string> {
  const mode = getMode();

  // Bridge mode: HTTP call
  if (mode === "bridge") {
    const body = JSON.stringify({ target_clid: targetClid, message });
    return await bridgeFetch("/api/message", "POST", body);
  }

  const escapedMsg = encodeTSString(message);
  return runCommands([
    "clientnotifyregister schandlerid=1 event=notifytextmessage",
    `sendtextmessage targetmode=1 target=${targetClid} msg=${escapedMsg}`,
  ]);
}

/**
 * Find a client by UID (for bot lookup).
 */
export async function findClientByUid(uid: string): Promise<number | null> {
  const mode = getMode();

  // Bridge mode: HTTP call
  if (mode === "bridge") {
    try {
      const raw = await bridgeFetch(`/api/client/uid/${encodeURIComponent(uid)}`);
      const client = JSON.parse(raw) as { clid: number };
      return client.clid;
    } catch { /* bot not found */ }
    return null;
  }

  const escapedUid = uid.replace(/\//g, "\\/");
  try {
    const raw = await runCommands([`clientgetids cluid=${escapedUid}`]);
    const lines = raw.split("\n");
    for (const line of lines) {
      if (line.includes("cluid=") && line.includes("clid=")) {
        const clidMatch = line.match(/clid=(\d+)/);
        if (clidMatch) return parseInt(clidMatch[1]);
      }
    }
  } catch { /* bot not found */ }
  return null;
}

/**
 * Get connection info (for logging/debugging)
 */
export function getTSConnectionInfo(): { mode: TSMode; host: string; port: number } {
  return { mode: getMode(), host: getHost(), port: getPort() };
}
