/**
 * Interacts with CrusaderBot via TeamSpeak.
 *
 * The bot has a permanent UID: JtyuT0YIadDhysblVvprGK/0Ces=
 * It appears with different names (CrusaderBot, ExptoBotModify) but same UID.
 *
 * Now uses the shared runCommands/sendTextMessage from clientquery.ts,
 * which handles both ClientQuery and ServerQuery modes, and respects
 * the global connection semaphore to avoid hitting connection limits.
 */

import fs from "fs";
import path from "path";
import net from "net";
import dotenv from "dotenv";
import {
  runCommands,
  findClientByUid,
  decodeTSString,
  encodeTSString,
  getTSConnectionInfo,
  acquireSemaphore,
  releaseSemaphore,
} from "./clientquery";

dotenv.config();

const BOT_UID = "JtyuT0YIadDhysblVvprGK/0Ces=";
const BOT_UID_FILE = path.join(__dirname, "..", "bot-uid.json");

// --- Clid persistence ---

function readLastKnownClid(): number | null {
  try {
    const raw = fs.readFileSync(BOT_UID_FILE, "utf-8");
    const data = JSON.parse(raw);
    return data.lastKnownClid ?? null;
  } catch {
    return null;
  }
}

function saveLastKnownClid(clid: number): void {
  try {
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(fs.readFileSync(BOT_UID_FILE, "utf-8"));
    } catch { /* file may not exist */ }
    data.uid = BOT_UID;
    data.lastKnownClid = clid;
    data.lastSuccessAt = new Date().toISOString();
    fs.writeFileSync(BOT_UID_FILE, JSON.stringify(data, null, 2));
  } catch { /* non-critical */ }
}

// --- Bot lookup ---

export async function getBotClidViaLookup(): Promise<number | null> {
  return findClientByUid(BOT_UID);
}

export async function getBotClid(): Promise<number | null> {
  const lastKnown = readLastKnownClid();
  if (lastKnown !== null) return lastKnown;
  return getBotClidViaLookup();
}

// --- RespInfo types ---

export interface RespInfoResult {
  code: string;
  currentPlayer: string;
  currentPlayerUid: string;
  claimTime: string;
  claimMinutes: number;
  nexts: Array<{
    position: number;
    player: string;
    playerUid: string;
    claimTime: string;
    claimMinutes: number;
  }>;
  totalQueueMinutes: number;
  freeAt: string;
  rawMessages: string[];
}

function parseClaimTime(str: string): number {
  const parts = str.split(":");
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h * 60 + m;
}

function parseRespInfoMessages(messages: string[]): Omit<RespInfoResult, "code" | "totalQueueMinutes" | "freeAt"> {
  let currentPlayer = "";
  let currentPlayerUid = "";
  let claimTime = "";
  let claimMinutes = 0;
  const nexts: RespInfoResult["nexts"] = [];

  for (const msg of messages) {
    // Parse "Ocupado por:" - with [url] BBCode first, then plain text
    const occupiedMatchUrl = msg.match(
      /Ocupado por:\s*\[url=client:\/\/\d+\/([^~]+)~\](.+?)\[\/url\]\s*Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (occupiedMatchUrl) {
      currentPlayerUid = occupiedMatchUrl[1];
      currentPlayer = occupiedMatchUrl[2];
      claimTime = occupiedMatchUrl[3];
      claimMinutes = parseClaimTime(claimTime);
      continue;
    }

    const occupiedMatchPlain = msg.match(
      /Ocupado por:\s*(.+?)\s+Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (occupiedMatchPlain) {
      currentPlayer = occupiedMatchPlain[1].trim();
      claimTime = occupiedMatchPlain[2];
      claimMinutes = parseClaimTime(claimTime);
      continue;
    }

    // Parse "- N:" queue entries
    const nextMatchUrl = msg.match(
      /-\s*(\d+):\s*\[url=client:\/\/\d+\/([^~]+)~\](.+?)\[\/url\]\s*Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (nextMatchUrl) {
      nexts.push({
        position: parseInt(nextMatchUrl[1]),
        player: nextMatchUrl[3],
        playerUid: nextMatchUrl[2],
        claimTime: nextMatchUrl[4],
        claimMinutes: parseClaimTime(nextMatchUrl[4]),
      });
      continue;
    }

    const nextMatchPlain = msg.match(
      /-\s*(\d+):\s*(.+?)\s+Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (nextMatchPlain) {
      nexts.push({
        position: parseInt(nextMatchPlain[1]),
        player: nextMatchPlain[2].trim(),
        playerUid: "",
        claimTime: nextMatchPlain[3],
        claimMinutes: parseClaimTime(nextMatchPlain[3]),
      });
    }
  }

  return { currentPlayer, currentPlayerUid, claimTime, claimMinutes, nexts, rawMessages: messages };
}

/**
 * Send !respinfo via bridge HTTP API.
 * 1. Clear existing messages
 * 2. Send message to bot
 * 3. Wait for bot to respond
 * 4. Collect responses
 */
async function sendRespInfoViaBridge(clid: number, code: string): Promise<string[] | null> {
  const http = await import("http");
  const bridgeUrl = process.env.BRIDGE_URL || "http://ts3bridge:8080";

  function bridgeReq(path: string, method = "GET", body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(bridgeUrl + path);
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || 80,
        path: urlObj.pathname,
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => data += chunk.toString());
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      if (body) req.write(body);
      req.end();
    });
  }

  try {
    // 1. Clear any existing messages
    await bridgeReq("/api/messages");

    // 2. Send !respinfo to bot
    const sendBody = JSON.stringify({ target_clid: clid, message: `!respinfo ${code}` });
    const sendResult = await bridgeReq("/api/message", "POST", sendBody);
    const sendParsed = JSON.parse(sendResult);
    if (!sendParsed.success) return null;

    // 3. Wait for bot to respond (poll a few times)
    const collectedMessages: string[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const msgResult = await bridgeReq("/api/messages");
      const msgs = JSON.parse(msgResult) as Array<{
        from_clid: number;
        from_name: string;
        from_uid: string;
        message: string;
        timestamp: number;
      }>;

      for (const msg of msgs) {
        if (msg.from_uid === BOT_UID) {
          collectedMessages.push(msg.message);
        }
      }

      // If we got messages and no new ones in last poll, we're done
      if (collectedMessages.length > 0 && msgs.filter(m => m.from_uid === BOT_UID).length === 0) {
        break;
      }
    }

    return collectedMessages.length > 0 ? collectedMessages : null;
  } catch (e) {
    console.error("[Bot] Bridge request failed:", e);
    return null;
  }
}

/**
 * Send !respinfo to the bot and collect responses.
 * Opens a raw TCP connection with event listening for the bot's response.
 * This is separate from runCommands because we need to:
 * 1. Register for events
 * 2. Send a message
 * 3. Wait for async event notifications (not regular command responses)
 *
 * Uses the global semaphore to ensure only ONE TS connection at a time.
 */
async function sendRespInfoAndCollect(clid: number, code: string): Promise<string[] | null> {
  const info = getTSConnectionInfo();

  // Bridge mode: use HTTP API
  if (info.mode === "bridge") {
    return sendRespInfoViaBridge(clid, code);
  }

  await acquireSemaphore();

  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(12000);
    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    let settled = false;
    let errorResponseCount = 0;
    const collectedMessages: string[] = [];

    const escapedMsg = encodeTSString(`!respinfo ${code}`);

    // Build auth + command sequence
    const authCmds = info.mode === "serverquery"
      ? [`login ${process.env.TS_QUERY_USER || "serveradmin"} ${process.env.TS_QUERY_PASS || ""}`, `use sid=${process.env.TS_VIRTUAL_SERVER || "1"}`]
      : [`auth apikey=${process.env.TS_APIKEY || ""}`];

    const allCmds = [
      ...authCmds,
      "clientnotifyregister schandlerid=1 event=notifytextmessage",
      `sendtextmessage targetmode=1 target=${clid} msg=${escapedMsg}`,
    ];

    function done(result: string[] | null) {
      if (settled) return;
      settled = true;
      if (waitTimer) clearTimeout(waitTimer);
      client.destroy();
      releaseSemaphore();
      resolve(result);
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

    let waitTimer: NodeJS.Timeout | null = null;

    client.connect(info.port, info.host, () => {});
    client.on("data", (chunk) => {
      const text = chunk.toString();
      fullData += text;

      // Detect connection limit
      if (fullData.includes("id=515") || fullData.includes("max\\sclients\\sprotocol\\slimit")) {
        done(null);
        return;
      }

      // Detect auth failure
      if (fullData.includes("id=512") || fullData.includes("id=768")) {
        done(null);
        return;
      }

      // Wait for ready
      if (!ready) {
        const isReady = info.mode === "serverquery"
          ? fullData.includes("ServerQuery") || fullData.includes("TS3")
          : fullData.includes("selected");
        if (isReady) {
          ready = true;
          trySendNext();
        }
        return;
      }

      // Collect bot response messages from events
      if (text.includes("notifytextmessage")) {
        const lines = text.split("\n");
        for (const line of lines) {
          if (!line.includes("notifytextmessage")) continue;
          const uidMatch = line.match(/invokeruid=([^\s]+)/);
          const msgMatch = line.match(/msg=([^\n]+?)(\s+timestamp=|\s*$)/);
          if (uidMatch && msgMatch) {
            const uid = decodeTSString(uidMatch[1]);
            if (uid === BOT_UID) {
              collectedMessages.push(decodeTSString(msgMatch[1]));
            }
          }
        }
      }

      // Send next command when previous finishes
      const newCount = countErrors(fullData);
      while (errorResponseCount < newCount) {
        errorResponseCount++;
        trySendNext();
      }
    });

    // Wait for bot responses, then close
    waitTimer = setTimeout(() => {
      done(collectedMessages.length > 0 ? collectedMessages : null);
    }, 5000);

    client.on("error", () => done(null));
    client.on("timeout", () => done(null));
  });
}

/**
 * Query !respinfo from the bot.
 * Tries last known clid first, then lookup by UID.
 */
export async function queryRespInfo(
  code: string,
  currentRemainingMin?: number
): Promise<RespInfoResult | null> {
  const lastKnown = readLastKnownClid();
  let messages: string[] | null = null;
  let usedClid: number | null = null;

  // Attempt 1: last known clid
  if (lastKnown !== null) {
    messages = await sendRespInfoAndCollect(lastKnown, code);
    if (messages) usedClid = lastKnown;
  }

  // Attempt 2: lookup by UID
  if (!messages) {
    const lookupClid = await getBotClidViaLookup();
    if (lookupClid !== null && lookupClid !== lastKnown) {
      messages = await sendRespInfoAndCollect(lookupClid, code);
      if (messages) usedClid = lookupClid;
    }
  }

  if (!messages || !usedClid) return null;

  saveLastKnownClid(usedClid);

  const parsed = parseRespInfoMessages(messages);

  const remaining = currentRemainingMin ?? parsed.claimMinutes;
  const nextsTotal = parsed.nexts.reduce((sum, n) => sum + n.claimMinutes, 0);
  const totalQueueMinutes = remaining + nextsTotal;

  const now = new Date();
  const freeDate = new Date(now.getTime() + totalQueueMinutes * 60 * 1000);
  const freeAt = `${String(freeDate.getHours()).padStart(2, "0")}:${String(freeDate.getMinutes()).padStart(2, "0")}`;

  return {
    code,
    ...parsed,
    totalQueueMinutes,
    freeAt,
  };
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "find";
  const info = getTSConnectionInfo();
  console.log(`Mode: ${info.mode} | Host: ${info.host}:${info.port}\n`);

  switch (command) {
    case "find": {
      console.log("Procurando CrusaderBot...");
      console.log(`UID: ${BOT_UID}\n`);
      const clid = await getBotClid();
      if (clid) {
        console.log(`Bot encontrado! CLID atual: ${clid}`);
      } else {
        console.log("Bot nao encontrado. Pode estar offline.");
      }
      break;
    }

    case "respinfo": {
      const respCode = args[1];
      if (!respCode) {
        console.log("Uso: npm run bot respinfo <codigo>");
        break;
      }
      console.log(`Consultando !respinfo ${respCode}...\n`);
      const result = await queryRespInfo(respCode);
      if (!result) {
        console.log("Sem resposta do bot.");
        break;
      }

      console.log(`Respawn ${respCode}:`);
      console.log(`  Ocupado por: ${result.currentPlayer}`);
      console.log(`  Tempo de claim: ${result.claimTime} (${result.claimMinutes}min)`);

      if (result.nexts.length > 0) {
        console.log(`  Fila (${result.nexts.length}):`);
        for (const n of result.nexts) {
          console.log(`    ${n.position}. ${n.player} - claim: ${n.claimTime} (${n.claimMinutes}min)`);
        }
      }

      console.log(`\n  Tempo total: ${result.totalQueueMinutes}min`);
      console.log(`  Respawn livre as: ~${result.freeAt}`);
      break;
    }

    default:
      console.log("Comandos:");
      console.log("  find              - Verifica se o bot esta online");
      console.log("  respinfo <codigo> - Consulta detalhes de um respawn");
  }
}

if (require.main === module) {
  main().catch(console.error);
}
