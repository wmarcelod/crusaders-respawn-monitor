import net from "net";

const CLIENTQUERY_PORT = 25639;
const CLIENTQUERY_HOST = "127.0.0.1";

export interface ClientQueryOptions {
  apiKey: string;
  timeout?: number;
}

export interface TSClient {
  clid: number;
  cid: number;
  nickname: string;
  clientType: number; // 0 = normal, 1 = serverquery
}

/**
 * Connects to TS3 ClientQuery, authenticates, runs commands, and returns raw output.
 * Uses "error id=" response markers to know when each command finishes before sending the next.
 * Always ensures the socket is destroyed after use to avoid leaking connections.
 */
export function runCommands(
  commands: string[],
  opts: ClientQueryOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = opts.timeout || 10000;
    client.setTimeout(timeout);
    let settled = false;

    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    // Count how many "error id=" responses we've seen (one per command)
    let errorResponseCount = 0;

    const allCmds = [`auth apikey=${opts.apiKey}`, ...commands, "quit"];

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

    client.connect(CLIENTQUERY_PORT, CLIENTQUERY_HOST, () => {});

    client.on("data", (chunk) => {
      fullData += chunk.toString();

      // Detect max clients limit reached - fail fast
      if (fullData.includes("id=515") || fullData.includes("max\\sclients\\sprotocol\\slimit")) {
        done(new Error("ClientQuery max connections limit reached (id=515). Restart TS client or wait."));
        return;
      }

      // Wait for the welcome message with "selected" before sending first command
      if (!ready && fullData.includes("selected")) {
        ready = true;
        trySendNext(); // send auth
        return;
      }

      if (!ready) return;

      // Count "error id=" markers to know when each command response is complete
      // TS sends "error id=N msg=..." after every command response
      const newCount = countErrors(fullData);
      while (errorResponseCount < newCount) {
        errorResponseCount++;
        // Each error response means a command finished — send the next one
        trySendNext();
      }
    });

    client.on("close", () => done());
    client.on("error", (err) => done(err));
    client.on("timeout", () => done(new Error("ClientQuery timeout")));
  });
}

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

/**
 * Get the description of a specific channel.
 * Retries once on failure (TS can return empty responses after connection pressure).
 */
export async function getChannelDescription(
  cid: number,
  apiKey: string
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await runCommands(
      [`channelvariable cid=${cid} channel_description`],
      { apiKey }
    );

    // Find the line containing channel_description=
    const lines = raw.split("\n");
    for (const line of lines) {
      const idx = line.indexOf("channel_description=");
      if (idx >= 0) {
        const value = line.substring(idx + "channel_description=".length).trim();
        return decodeTSString(value);
      }
    }

    // Check if channel_description exists but without value (empty description)
    const rawLines = raw.split("\n");
    for (const line of rawLines) {
      // "cid=160 channel_description" (no = sign means empty)
      if (line.includes("channel_description") && !line.includes("channel_description=")) {
        return ""; // empty description
      }
    }

    // First attempt failed - wait a bit and retry
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
  apiKey: string
): Promise<Array<{ cid: number; name: string; clients: number }>> {
  const raw = await runCommands(["channellist"], { apiKey });

  // The channellist response is between the auth "error id=0" and the next "error id="
  // Format: cid=1 ... channel_name=...|cid=2 ...\nerror id=0 msg=ok
  // Find the line(s) containing "cid=" entries (they are pipe-separated on one line)
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
    // channel_name value goes until the next known key or end of entry
    const nameMatch = entry.match(/channel_name=(.+?)(?:\s+channel_flag|\s+total_clients|\s*$)/);
    const clientsMatch = entry.match(/total_clients=(\d+)/);

    return {
      cid: parseInt(cidMatch?.[1] || "0"),
      name: decodeTSString(nameMatch?.[1]?.trim() || "?"),
      clients: parseInt(clientsMatch?.[1] || "0"),
    };
  });
}

/**
 * Find the Respawn List channel (the one whose name contains "Respawn List")
 */
export async function findRespawnListChannel(
  apiKey: string
): Promise<{ cid: number; name: string; count: number } | null> {
  const channels = await getChannelList(apiKey);
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
 * Find the Respawn Number channel (catalog of all respawns)
 */
export async function findRespawnNumberChannel(
  apiKey: string
): Promise<{ cid: number; name: string; count: number } | null> {
  const channels = await getChannelList(apiKey);
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
 * Get all connected clients from TeamSpeak via ClientQuery.
 * Filters out serverquery bots (client_type=1).
 */
export async function getAllClients(apiKey: string): Promise<TSClient[]> {
  const raw = await runCommands(["clientlist"], { apiKey });

  // The clientlist response is pipe-separated entries on one line:
  // clid=1 cid=5 client_database_id=2 client_nickname=PlayerName client_type=0|clid=2 ...
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

    // Skip serverquery bots
    if (clientType === 1) continue;

    const nickname = decodeTSString(nicknameMatch?.[1]?.trim() || "");
    // Skip clients with empty/invalid nicknames
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
