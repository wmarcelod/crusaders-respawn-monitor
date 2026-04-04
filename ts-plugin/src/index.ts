/**
 * TS3 Local Plugin Agent
 *
 * Runs on the user's PC alongside the TS3 client.
 * Connects to ClientQuery (localhost:25639) to query the bot.
 * Polls the dashboard for pending bot queries and pushes results.
 *
 * Authentication: uses PLUGIN_SECRET shared between plugin and dashboard.
 * All requests include Authorization: Bearer <secret> header.
 */

import net from "net";
import https from "https";
import http from "http";
import dotenv from "dotenv";

dotenv.config();

// --- Config ---
const TS_APIKEY = process.env.TS_APIKEY || "";
const DASHBOARD_URL = process.env.DASHBOARD_URL || "https://ts3.marcelod.com.br";
const PLUGIN_SECRET = process.env.PLUGIN_SECRET || "crusaders2026";
const BOT_UID = process.env.BOT_UID || "JtyuT0YIadDhysblVvprGK/0Ces=";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "5") * 1000;
const CQ_HOST = "127.0.0.1";
const CQ_PORT = 25639;

// --- Logging ---
function log(msg: string): void {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] ${msg}`);
}

// --- TS escape/decode ---
function decodeTSString(str: string): string {
  return str
    .replace(/\\s/g, " ")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\p/g, "|")
    .replace(/\\\//g, "/");
}

function encodeTSString(str: string): string {
  return str
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\//g, "\\/");
}

// --- HTTP helper with auth ---
function dashboardRequest(path: string, method = "GET", body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(DASHBOARD_URL + path);
    const isHttps = url.protocol === "https:";
    const mod = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        "Authorization": `Bearer ${PLUGIN_SECRET}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      timeout: 10000,
    };

    const req = mod.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    if (body) req.write(body);
    req.end();
  });
}

// --- ClientQuery: send !respinfo and collect bot response ---

interface RespInfoResult {
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

function parseRespInfoMessages(messages: string[], code: string, remainingMin: number): RespInfoResult {
  let currentPlayer = "";
  let currentPlayerUid = "";
  let claimTime = "";
  let claimMinutes = 0;
  const nexts: RespInfoResult["nexts"] = [];

  for (const msg of messages) {
    // Parse "Ocupado por:" with [url] BBCode
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

    // Parse "Ocupado por:" plain text
    const occupiedMatchPlain = msg.match(
      /Ocupado por:\s*(.+?)\s+Tempo de claim\s+(\d+:\d+:\d+)/
    );
    if (occupiedMatchPlain) {
      currentPlayer = occupiedMatchPlain[1].trim();
      claimTime = occupiedMatchPlain[2];
      claimMinutes = parseClaimTime(claimTime);
      continue;
    }

    // Parse queue entries "- N:"
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

  const nextsTotal = nexts.reduce((sum, n) => sum + n.claimMinutes, 0);
  const totalQueueMinutes = Math.max(0, remainingMin) + nextsTotal;
  const now = new Date();
  const freeDate = new Date(now.getTime() + totalQueueMinutes * 60 * 1000);
  const freeAt = `${String(freeDate.getHours()).padStart(2, "0")}:${String(freeDate.getMinutes()).padStart(2, "0")}`;

  return {
    code,
    currentPlayer,
    currentPlayerUid,
    claimTime,
    claimMinutes,
    nexts,
    totalQueueMinutes,
    freeAt,
    rawMessages: messages,
  };
}

/**
 * Send !respinfo to bot via ClientQuery and collect response messages.
 * Opens a TCP connection, authenticates, registers for events, sends message, waits for response.
 */
function queryBotViaClientQuery(botClid: number, code: string): Promise<string[] | null> {
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

    const allCmds = [
      `auth apikey=${TS_APIKEY}`,
      "clientnotifyregister schandlerid=1 event=notifytextmessage",
      `sendtextmessage targetmode=1 target=${botClid} msg=${escapedMsg}`,
    ];

    function done(result: string[] | null) {
      if (settled) return;
      settled = true;
      if (waitTimer) clearTimeout(waitTimer);
      client.destroy();
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

    client.connect(CQ_PORT, CQ_HOST, () => {});

    client.on("data", (chunk) => {
      const text = chunk.toString();
      fullData += text;

      if (fullData.includes("id=515")) {
        log("TS3 max connections limit hit");
        done(null);
        return;
      }
      if (fullData.includes("id=256") || fullData.includes("id=520")) {
        log("Auth failed - check TS_APIKEY");
        done(null);
        return;
      }

      if (!ready) {
        if (fullData.includes("selected")) {
          ready = true;
          trySendNext();
        }
        return;
      }

      // Collect bot response from event notifications
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

      const newCount = countErrors(fullData);
      while (errorResponseCount < newCount) {
        errorResponseCount++;
        trySendNext();
      }
    });

    // Wait 5s for bot responses
    waitTimer = setTimeout(() => {
      done(collectedMessages.length > 0 ? collectedMessages : null);
    }, 5000);

    client.on("error", (err) => { log(`CQ error: ${err.message}`); done(null); });
    client.on("timeout", () => { log("CQ timeout"); done(null); });
  });
}

/**
 * Find bot clid via ClientQuery (clientgetids by UID)
 */
function findBotClid(): Promise<number | null> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    client.setTimeout(8000);
    let fullData = "";
    let ready = false;
    let cmdIdx = 0;
    let settled = false;
    let errorResponseCount = 0;

    const escapedUid = BOT_UID.replace(/\//g, "\\/");
    const allCmds = [
      `auth apikey=${TS_APIKEY}`,
      `clientgetids cluid=${escapedUid}`,
      "quit",
    ];

    function done(result: number | null) {
      if (settled) return;
      settled = true;
      client.destroy();
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
      while ((idx = data.indexOf("error id=", idx)) !== -1) { count++; idx += 9; }
      return count;
    }

    client.connect(CQ_PORT, CQ_HOST, () => {});
    client.on("data", (chunk) => {
      fullData += chunk.toString();

      if (!ready) {
        if (fullData.includes("selected")) {
          ready = true;
          trySendNext();
        }
        return;
      }

      const newCount = countErrors(fullData);
      while (errorResponseCount < newCount) {
        errorResponseCount++;
        trySendNext();
      }
    });

    client.on("close", () => {
      const lines = fullData.split("\n");
      for (const line of lines) {
        if (line.includes("cluid=") && line.includes("clid=")) {
          const match = line.match(/clid=(\d+)/);
          if (match) { done(parseInt(match[1])); return; }
        }
      }
      done(null);
    });

    client.on("error", () => done(null));
    client.on("timeout", () => done(null));
  });
}

// --- Main loop ---

interface PendingQuery {
  code: string;
  nexts: number;
  remainingMin: number;
}

let isProcessing = false;
let botClid: number | null = null;
let consecutiveErrors = 0;

async function pollAndProcess(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;

  try {
    // 1. Poll dashboard for pending queries
    const raw = await dashboardRequest("/api/plugin/poll");
    const response = JSON.parse(raw) as {
      pending: PendingQuery[];
      pluginActive: boolean;
    };

    consecutiveErrors = 0;

    if (response.pending.length === 0) {
      isProcessing = false;
      return;
    }

    log(`${response.pending.length} consulta(s) pendente(s): ${response.pending.map(p => p.code).join(", ")}`);

    // 2. Find bot clid if we don't have it
    if (botClid === null) {
      log("Procurando CrusaderBot...");
      botClid = await findBotClid();
      if (botClid === null) {
        log("Bot nao encontrado no TS3. TS3 esta aberto?");
        isProcessing = false;
        return;
      }
      log(`Bot encontrado: clid=${botClid}`);
    }

    // 3. Process each pending query
    for (const item of response.pending) {
      log(`Consultando !respinfo ${item.code}...`);

      const messages = await queryBotViaClientQuery(botClid, item.code);

      if (messages) {
        const result = parseRespInfoMessages(messages, item.code, item.remainingMin);
        log(`${item.code}: ${result.currentPlayer} | fila: ${result.nexts.length} | livre as: ${result.freeAt}`);

        // Push result to dashboard
        await dashboardRequest("/api/plugin/respinfo", "POST", JSON.stringify({
          code: item.code,
          data: result,
        }));
      } else {
        log(`${item.code}: sem resposta do bot`);
        // Retry: maybe bot clid changed
        botClid = null;
      }

      // Delay between queries
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (err: any) {
    consecutiveErrors++;
    if (consecutiveErrors <= 3) {
      log(`Erro: ${err.message}`);
    } else if (consecutiveErrors === 4) {
      log("Muitos erros consecutivos, silenciando...");
    }
  }

  isProcessing = false;
}

// --- Startup ---

async function main(): Promise<void> {
  console.log("============================================");
  console.log("  TS3 Plugin - Crusaders Respawn Monitor");
  console.log("============================================");
  console.log(`  Dashboard:  ${DASHBOARD_URL}`);
  console.log(`  Bot UID:    ${BOT_UID}`);
  console.log(`  Poll:       ${POLL_INTERVAL / 1000}s`);
  console.log(`  ApiKey:     ${TS_APIKEY ? "***" + TS_APIKEY.slice(-4) : "NAO CONFIGURADA"}`);
  console.log("============================================\n");

  if (!TS_APIKEY) {
    console.error("ERRO: TS_APIKEY nao configurada! Veja .env.example");
    process.exit(1);
  }

  // Test ClientQuery connection
  log("Testando conexao com ClientQuery...");
  const testClid = await findBotClid();
  if (testClid !== null) {
    botClid = testClid;
    log(`ClientQuery OK! Bot clid=${botClid}`);
  } else {
    log("Bot nao encontrado, mas ClientQuery parece acessivel. Vou tentar novamente no polling.");
  }

  // Test dashboard connection
  log("Testando conexao com dashboard...");
  try {
    await dashboardRequest("/api/plugin/poll");
    log("Dashboard OK!");
  } catch (err: any) {
    log(`Dashboard erro: ${err.message}`);
    log("Verifique DASHBOARD_URL e PLUGIN_SECRET no .env");
  }

  console.log("");
  log("Plugin ativo! Polling a cada " + (POLL_INTERVAL / 1000) + "s...\n");

  // Main polling loop
  setInterval(pollAndProcess, POLL_INTERVAL);
  pollAndProcess(); // Run immediately
}

main().catch(console.error);
