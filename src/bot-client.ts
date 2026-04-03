/**
 * Interacts with CrusaderBot via TeamSpeak ClientQuery.
 *
 * The bot has a permanent UID: JtyuT0YIadDhysblVvprGK/0Ces=
 * It appears with different names (CrusaderBot, ExptoBotModify) but same UID.
 *
 * Strategy: always try to communicate. Use last known clid from bot-uid.json first,
 * fall back to clientgetids, and save successful clid for next time.
 */

import net from "net";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.TS_APIKEY || "5AEH-W5S8-NGYT-ETWX-7WPK-0FV0";
const BOT_UID = "JtyuT0YIadDhysblVvprGK/0Ces=";
const BOT_UID_ESCAPED = "JtyuT0YIadDhysblVvprGK\\/0Ces=";
const BOT_UID_FILE = path.join(__dirname, "..", "bot-uid.json");

function decodeTSString(str: string): string {
  return str
    .replace(/\\s/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\p/g, "|")
    .replace(/\\\//g, "/");
}

function escapeTSString(str: string): string {
  return str
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\//g, "\\/");
}

/**
 * Read last known clid from bot-uid.json.
 * Returns null if file doesn't exist or clid not set.
 */
function readLastKnownClid(): number | null {
  try {
    const raw = fs.readFileSync(BOT_UID_FILE, "utf-8");
    const data = JSON.parse(raw);
    return data.lastKnownClid ?? null;
  } catch {
    return null;
  }
}

/**
 * Save successful clid to bot-uid.json for next time.
 */
function saveLastKnownClid(clid: number): void {
  try {
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(fs.readFileSync(BOT_UID_FILE, "utf-8"));
    } catch { /* file may not exist yet */ }
    data.uid = BOT_UID;
    data.lastKnownClid = clid;
    data.lastSuccessAt = new Date().toISOString();
    fs.writeFileSync(BOT_UID_FILE, JSON.stringify(data, null, 2));
  } catch { /* non-critical */ }
}

/**
 * Get the bot's current clid by its UID using clientgetids.
 * Returns null if the bot is not found.
 */
export async function getBotClidViaLookup(): Promise<number | null> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(8000);
    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    let timer: NodeJS.Timeout | null = null;
    let lastLen = 0;
    let settled = false;

    const cmds = [
      `auth apikey=${API_KEY}`,
      `clientgetids cluid=${BOT_UID_ESCAPED}`,
      "quit",
    ];

    function done(result: number | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      client.destroy();
      resolve(result);
    }

    function trySendNext() {
      if (cmdIdx < cmds.length) {
        client.write(cmds[cmdIdx++] + "\r\n");
      }
    }

    client.connect(25639, "127.0.0.1", () => {});
    client.on("data", (chunk) => {
      fullData += chunk.toString();

      // Detect max clients limit
      if (fullData.includes("id=515") || fullData.includes("max\\sclients\\sprotocol\\slimit")) {
        done(null);
        return;
      }

      if (!ready && fullData.includes("selected")) {
        ready = true;
        trySendNext();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (fullData.length > lastLen) {
          lastLen = fullData.length;
          trySendNext();
        }
      }, 200);
    });
    client.on("close", () => {
      if (settled) return;
      const lines = fullData.split("\n");
      for (const line of lines) {
        if (line.includes("cluid=") && line.includes("clid=")) {
          const clidMatch = line.match(/clid=(\d+)/);
          if (clidMatch) {
            done(parseInt(clidMatch[1]));
            return;
          }
        }
      }
      done(null);
    });
    client.on("error", () => done(null));
    client.on("timeout", () => done(null));
  });
}

/** Kept for backward compat - tries last known clid first, then lookup */
export async function getBotClid(): Promise<number | null> {
  const lastKnown = readLastKnownClid();
  if (lastKnown !== null) return lastKnown;
  return getBotClidViaLookup();
}

export interface RespInfoResult {
  code: string;
  currentPlayer: string;
  currentPlayerUid: string;
  claimTime: string; // e.g., "02:30:00"
  claimMinutes: number;
  nexts: Array<{
    position: number;
    player: string;
    playerUid: string;
    claimTime: string;
    claimMinutes: number;
  }>;
  /** Total time until respawn is completely free (current remaining + all nexts) */
  totalQueueMinutes: number;
  /** Estimated time when respawn will be completely free */
  freeAt: string;
  rawMessages: string[];
}

/**
 * Parse a claim time string like "02:30:00" to minutes
 */
function parseClaimTime(str: string): number {
  const parts = str.split(":");
  const h = parseInt(parts[0]) || 0;
  const m = parseInt(parts[1]) || 0;
  return h * 60 + m;
}

/**
 * Parse the bot's !respinfo response messages
 */
function parseRespInfoMessages(messages: string[]): Omit<RespInfoResult, "code" | "totalQueueMinutes" | "freeAt"> {
  let currentPlayer = "";
  let currentPlayerUid = "";
  let claimTime = "";
  let claimMinutes = 0;
  const nexts: RespInfoResult["nexts"] = [];

  for (const msg of messages) {
    const decoded = msg;

    // Parse "Ocupado por:" - try with [url] BBCode first, then plain text
    const occupiedMatchUrl = decoded.match(
      /Ocupado por:\s*\[url=client:\/\/\d+\/([^~]+)~\](.+?)\[\/url\]\s*Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (occupiedMatchUrl) {
      currentPlayerUid = occupiedMatchUrl[1];
      currentPlayer = occupiedMatchUrl[2];
      claimTime = occupiedMatchUrl[3];
      claimMinutes = parseClaimTime(claimTime);
      continue;
    }

    // Fallback: plain text "Ocupado por: PlayerName Tempo de claim HH:MM:SS"
    const occupiedMatchPlain = decoded.match(
      /Ocupado por:\s*(.+?)\s+Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (occupiedMatchPlain) {
      currentPlayer = occupiedMatchPlain[1].trim();
      claimTime = occupiedMatchPlain[2];
      claimMinutes = parseClaimTime(claimTime);
      continue;
    }

    // Parse "- N:" queue entries - try with [url] BBCode first, then plain text
    const nextMatchUrl = decoded.match(
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

    // Fallback: plain text "- N: PlayerName Tempo de claim HH:MM:SS"
    const nextMatchPlain = decoded.match(
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
 * Try to send !respinfo using a specific clid.
 * Returns collected messages or null on failure.
 */
function trySendRespInfo(
  clid: number,
  code: string
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(12000);
    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    let timer: NodeJS.Timeout | null = null;
    let lastLen = 0;
    let settled = false;
    const collectedMessages: string[] = [];

    const escapedMsg = escapeTSString(`!respinfo ${code}`);

    const cmds = [
      `auth apikey=${API_KEY}`,
      "clientnotifyregister schandlerid=1 event=notifytextmessage",
      `sendtextmessage targetmode=1 target=${clid} msg=${escapedMsg}`,
    ];

    function done(result: string[] | null) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (waitTimer) clearTimeout(waitTimer);
      client.destroy();
      resolve(result);
    }

    function trySendNext() {
      if (cmdIdx < cmds.length) {
        client.write(cmds[cmdIdx++] + "\r\n");
      }
    }

    let waitTimer: NodeJS.Timeout | null = null;

    client.connect(25639, "127.0.0.1", () => {});
    client.on("data", (chunk) => {
      const text = chunk.toString();
      fullData += text;

      // Detect max clients limit
      if (fullData.includes("id=515") || fullData.includes("max\\sclients\\sprotocol\\slimit")) {
        done(null);
        return;
      }

      if (!ready && fullData.includes("selected")) {
        ready = true;
        trySendNext();
        return;
      }

      // Check for error after sendtextmessage (e.g., invalid clid)
      if (fullData.includes("error id=512") || fullData.includes("error id=768")) {
        done(null);
        return;
      }

      // Collect bot response messages
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

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (fullData.length > lastLen) {
          lastLen = fullData.length;
          trySendNext();
        }
      }, 200);
    });

    // Wait for all response messages (bot sends multiple), then clean up
    waitTimer = setTimeout(() => {
      done(collectedMessages.length > 0 ? collectedMessages : null);
    }, 5000);

    client.on("error", () => done(null));
    client.on("timeout", () => done(null));
  });
}

/**
 * Send !respinfo to the bot and parse the response.
 * Tries last known clid first, falls back to clientgetids lookup.
 * @param code - The respawn code, e.g., "201a"
 * @param currentRemainingMin - How many minutes the current occupant has left (from the TS channel data)
 */
export async function queryRespInfo(
  code: string,
  currentRemainingMin?: number
): Promise<RespInfoResult | null> {
  // Strategy: try lastKnownClid first, then clientgetids
  const lastKnown = readLastKnownClid();
  let messages: string[] | null = null;
  let usedClid: number | null = null;

  // Attempt 1: last known clid
  if (lastKnown !== null) {
    messages = await trySendRespInfo(lastKnown, code);
    if (messages) usedClid = lastKnown;
  }

  // Attempt 2: clientgetids lookup
  if (!messages) {
    const lookupClid = await getBotClidViaLookup();
    if (lookupClid !== null && lookupClid !== lastKnown) {
      messages = await trySendRespInfo(lookupClid, code);
      if (messages) usedClid = lookupClid;
    }
  }

  // No response from either attempt
  if (!messages || !usedClid) {
    return null;
  }

  // Save successful clid for next time
  saveLastKnownClid(usedClid);

  const parsed = parseRespInfoMessages(messages);

  // Calculate total queue time
  const remaining = currentRemainingMin ?? parsed.claimMinutes;
  const nextsTotal = parsed.nexts.reduce((sum, n) => sum + n.claimMinutes, 0);
  const totalQueueMinutes = remaining + nextsTotal;

  // Calculate estimated free time
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

// CLI interface
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "find";

  switch (command) {
    case "find": {
      console.log("Procurando CrusaderBot...");
      console.log(`UID: ${BOT_UID}\n`);
      const clid = await getBotClid();
      if (clid) {
        console.log(`Bot encontrado! CLID atual: ${clid}`);
      } else {
        console.log("Bot nao encontrado. Pode estar offline ou com clid diferente.");
      }
      break;
    }

    case "respinfo": {
      const code = args[1];
      if (!code) {
        console.log("Uso: npm run bot respinfo <codigo>");
        console.log("Ex:  npm run bot respinfo 201a");
        break;
      }
      console.log(`Consultando !respinfo ${code}...\n`);
      const result = await queryRespInfo(code);
      if (!result) {
        console.log("Sem resposta do bot.");
        break;
      }

      console.log(`Respawn ${code}:`);
      console.log(`  Ocupado por: ${result.currentPlayer}`);
      console.log(`  Tempo de claim: ${result.claimTime} (${result.claimMinutes}min)`);

      if (result.nexts.length > 0) {
        console.log(`  Fila (${result.nexts.length}):`);
        for (const n of result.nexts) {
          console.log(`    ${n.position}. ${n.player} - claim: ${n.claimTime} (${n.claimMinutes}min)`);
        }
      } else {
        console.log("  Sem fila.");
      }

      console.log(`\n  Tempo total na fila: ${result.totalQueueMinutes}min`);
      console.log(`  Respawn livre as: ~${result.freeAt}`);
      break;
    }

    default:
      console.log("Comandos:");
      console.log("  find              - Verifica se o bot esta online");
      console.log("  respinfo <codigo> - Consulta detalhes de um respawn");
  }
}

// Only run CLI when executed directly (not when imported as module)
if (require.main === module) {
  main().catch(console.error);
}
