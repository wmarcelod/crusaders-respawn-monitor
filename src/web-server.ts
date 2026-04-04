import http from "http";
import {
  getChannelDescription,
  getChannelList,
  findRespawnListChannel,
  findRespawnNumberChannel,
} from "./clientquery";
import {
  parseRespawnList,
  parseRespawnCatalog,
  RespawnListData,
  RespawnEntry,
  RespawnCatalog,
} from "./respawn-parser";
import {
  fetchReservations,
  getActiveReservations,
  ActiveReservation,
  ReservationData,
} from "./sheets-parser";
import { findReservationsForRespawnByCode, matchRespawnName } from "./respawn-matcher";
import { queryRespInfo, RespInfoResult } from "./bot-client";
import { processSnapshot, getLogStats, getPlayerProfile, getRespawnHistory, getPlayerRespawnHistory, RespawnLogEntry, PlayerProfile } from "./respawn-logger";
import { fetchCharacter, fetchCharacterFull, fetchCharacters, extractCharNames, shortVocation, TibiaCharacter, TibiaCharacterFull } from "./tibia-api";
import { startClientTracker, getTrackedClients, getTrackedClient } from "./client-tracker";
import { getTSConnectionInfo } from "./clientquery";
import dotenv from "dotenv";

dotenv.config();

const WEB_PORT = parseInt(process.env.WEB_PORT || "3000");

// Cache
let cachedData: RespawnListData | null = null;
let cachedCatalog: RespawnCatalog | null = null;
let cachedReservations: ReservationData | null = null;
let lastFetch = 0;
let lastReservationFetch = 0;
const CACHE_MS = 2_000; // 2s - fast refresh for TS respawn data
const RESERVATION_CACHE_MS = 300_000; // 5 min - Google Sheets reservations
const PLAYER_CACHE_MS_TIBIA = 600_000; // 10 min - TibiaData player info

// Bot respinfo cache: change-based (invalidated when nexts count changes)
const respInfoCache = new Map<string, { data: RespInfoResult | null; nextsWhenFetched: number }>();
let lastKnownNexts: Record<string, number> = {};
let lastBotContact: Date | null = null;

/** Get cached respinfo for a code (used for inline display). Does not trigger fetch. */
function getCachedRespInfo(code: string): RespInfoResult | null {
  return respInfoCache.get(code)?.data || null;
}

// --- Serial bot query queue (one at a time to avoid response mixing) ---
interface BotQueueItem {
  code: string;
  nexts: number;
  remainingMin?: number;
  resolve?: (data: RespInfoResult | null) => void;
}
const botQueryQueue: BotQueueItem[] = [];
let botQueryRunning = false;

/** Process the bot query queue serially - one !respinfo at a time */
async function processBotQueue(): Promise<void> {
  if (botQueryRunning) return;
  botQueryRunning = true;

  while (botQueryQueue.length > 0) {
    const item = botQueryQueue.shift()!;
    try {
      const data = await queryRespInfo(item.code, item.remainingMin);
      respInfoCache.set(item.code, { data, nextsWhenFetched: item.nexts });
      if (data) lastBotContact = new Date();
      item.resolve?.(data);
    } catch {
      item.resolve?.(respInfoCache.get(item.code)?.data || null);
    }
    // Small delay between queries to not spam the bot
    await new Promise((r) => setTimeout(r, 1500));
  }

  botQueryRunning = false;
}

/** Enqueue a background bot query (non-blocking, no response needed) */
function triggerBotQuery(code: string, nexts: number, remainingMin?: number): void {
  // Don't add duplicates
  if (botQueryQueue.some((q) => q.code === code)) return;
  botQueryQueue.push({ code, nexts, remainingMin });
  processBotQueue();
}

/** Check which respawns had nexts changes and enqueue serial bot queries */
function checkAndTriggerBotQueries(entries: RespawnEntry[]): void {
  for (const e of entries) {
    if (e.nexts > 0) {
      const prev = lastKnownNexts[e.code] ?? -1;
      if (prev !== e.nexts) {
        triggerBotQuery(e.code, e.nexts, e.remainingMinutes);
      }
    }
    lastKnownNexts[e.code] = e.nexts;
  }
}

/** Fetch respinfo with serial queue (awaitable - for API/modal requests) */
async function fetchRespInfoCached(code: string, remainingMin?: number, forceRefresh = false): Promise<RespInfoResult | null> {
  const cached = respInfoCache.get(code);
  const currentNexts = lastKnownNexts[code] ?? 0;

  // Return cached if nexts haven't changed and not forcing refresh
  if (!forceRefresh && cached && cached.nextsWhenFetched === currentNexts) {
    return cached.data;
  }

  // Use the serial queue but await the result
  return new Promise((resolve) => {
    // Remove any existing pending query for this code
    const idx = botQueryQueue.findIndex((q) => q.code === code);
    if (idx >= 0) botQueryQueue.splice(idx, 1);

    // Add to front of queue (user-requested = priority)
    botQueryQueue.unshift({ code, nexts: currentNexts, remainingMin, resolve });
    processBotQueue();
  });
}

async function fetchCatalog(): Promise<RespawnCatalog> {
  if (cachedCatalog) return cachedCatalog;
  try {
    const numCh = await findRespawnNumberChannel();
    if (!numCh) return {};
    const desc = await getChannelDescription(numCh.cid);
    if (!desc || desc.trim().length === 0) {
      console.log("[Catalog] Channel description is empty, skipping catalog");
      return {};
    }
    cachedCatalog = parseRespawnCatalog(desc);
    setTimeout(() => { cachedCatalog = null; }, 5 * 60 * 1000);
    return cachedCatalog;
  } catch (err: any) {
    console.error("[Catalog] Failed to fetch:", err?.message || err);
    return cachedCatalog || {}; // return stale cache or empty
  }
}

async function fetchReservationsCached(): Promise<ReservationData | null> {
  const now = Date.now();
  if (cachedReservations && now - lastReservationFetch < RESERVATION_CACHE_MS) {
    return cachedReservations;
  }
  try {
    cachedReservations = await fetchReservations();
    lastReservationFetch = now;
    return cachedReservations;
  } catch {
    return cachedReservations;
  }
}

// Player Tibia data cache for dashboard display
let cachedPlayerData: Map<string, TibiaCharacter> = new Map();
let lastPlayerFetch = 0;

async function fetchPlayerDataCached(names: string[]): Promise<Map<string, TibiaCharacter>> {
  const now = Date.now();
  if (now - lastPlayerFetch < PLAYER_CACHE_MS_TIBIA && cachedPlayerData.size > 0) {
    return cachedPlayerData;
  }

  try {
    const allCharNames = names.flatMap((n) => extractCharNames(n));
    const data = await fetchCharacters(allCharNames);
    cachedPlayerData = data;
    lastPlayerFetch = now;
    return data;
  } catch (err: any) {
    console.error("fetchPlayerDataCached error:", err?.message || err);
    return cachedPlayerData;
  }
}

async function fetchAllData(): Promise<{
  respawns: RespawnListData;
  reservations: ReservationData | null;
  activeReservations: ActiveReservation[];
  playerData: Map<string, TibiaCharacter>;
}> {
  const now = Date.now();

  // Serialize TS calls (semaphore in clientquery.ts handles this).
  // Google Sheets runs in parallel since it's HTTP, not TS.
  const reservationsPromise = fetchReservationsCached();
  const channel = await findRespawnListChannel();
  const catalog = await fetchCatalog();
  const reservations = await reservationsPromise;

  if (!channel) {
    throw new Error("Canal Respawn List nao encontrado. Conecte ao servidor no TS.");
  }

  let respawns: RespawnListData;
  let isNewFetch = false;
  if (cachedData && now - lastFetch < CACHE_MS) {
    respawns = cachedData;
  } else {
    const desc = await getChannelDescription(channel.cid);
    respawns = parseRespawnList(desc, catalog);
    cachedData = respawns;
    lastFetch = now;
    isNewFetch = true;
  }

  // Log respawn usage on each fresh fetch (non-blocking)
  if (isNewFetch) {
    processSnapshot(respawns.entries).catch(() => {});
    // Check for nexts changes and trigger background bot queries
    checkAndTriggerBotQueries(respawns.entries);
  }

  const activeReservations = reservations
    ? getActiveReservations(reservations.all)
    : [];

  // Fetch Tibia character data for current players
  const playerNames = respawns.entries.map((e) => e.occupiedBy);
  const playerData = await fetchPlayerDataCached(playerNames);
  return { respawns, reservations, activeReservations, playerData };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(e: RespawnEntry): string {
  if (e.isEntryWindow) return '<span class="badge entry-window">TROCANDO</span>';
  if (e.elapsedMinutes >= e.totalMinutes) return '<span class="badge entry-window">SAINDO</span>';
  if (e.isAlmostDone) return '<span class="badge almost">ACABANDO</span>';
  return '<span class="badge ok">OK</span>';
}

function progressColor(percent: number): string {
  if (percent >= 100) return "#e74c3c";
  if (percent >= 80) return "#f39c12";
  if (percent >= 50) return "#2ecc71";
  return "#3498db";
}

function renderHTML(
  data: RespawnListData,
  reservations: ReservationData | null,
  activeReservations: ActiveReservation[],
  playerData?: Map<string, TibiaCharacter>
): string {
  const rows = data.entries
    .map((e) => {
      const pColor = progressColor(e.progressPercent);
      const timeUp = e.elapsedMinutes >= e.totalMinutes;
      const rowClass = timeUp
        ? "entry-window-row"
        : e.isAlmostDone
        ? "almost-row"
        : "";

      // Look up Tibia character data for this player
      // Prefer client tracker data (tracks ALL clients), fall back to playerData map
      let vocClass = "?";
      let level = 0;
      let playerHtml = `<a href="/player/${encodeURIComponent(e.occupiedBy)}" class="player-link"><span class="player-name">${escapeHtml(e.occupiedBy)}</span></a>`;

      let tc: TibiaCharacter | null = null;
      let resolvedCharName: string | null = null;

      // Try client tracker first (has data for ALL connected TS clients)
      const tracked = getTrackedClient(e.occupiedBy);
      if (tracked?.tibiaData) {
        tc = tracked.tibiaData;
        resolvedCharName = tracked.charName;
      }

      // Fall back to playerData map if tracker didn't have it
      if (!tc && playerData) {
        const charNames = extractCharNames(e.occupiedBy);
        for (const cn of charNames) {
          const found = playerData.get(cn);
          if (found) {
            tc = found;
            resolvedCharName = cn;
            break;
          }
        }
      }

      if (tc && resolvedCharName) {
        vocClass = shortVocation(tc.vocation).toLowerCase();
        level = tc.level;
        playerHtml = `<a href="/player/${encodeURIComponent(e.occupiedBy)}" class="player-link"><span class="player-name">${escapeHtml(e.occupiedBy)}</span></a>`
          + `<div class="player-info">`
          + `<span class="voc-badge ${vocClass}">${shortVocation(tc.vocation)}</span>`
          + `<span class="player-level">Lv${tc.level}</span>`
          + (tc.guild ? `<span class="player-guild">${escapeHtml(tc.guild)}</span>` : "")
          + `</div>`;
      }

      // Calculate "Livre as" - when the respawn will actually be free
      const botData = getCachedRespInfo(e.code);
      let freeAt: string;
      let hasBotQueue = false;
      if (e.nexts > 0 && botData && botData.nexts && botData.nexts.length > 0) {
        // Recalculate using current remaining + each person's actual claim time from bot
        const nextsTotal = botData.nexts.reduce((sum, n) => sum + n.claimMinutes, 0);
        const totalQueueMin = Math.max(0, e.remainingMinutes) + nextsTotal;
        const freeDate = new Date(Date.now() + totalQueueMin * 60 * 1000);
        freeAt = `${String(freeDate.getHours()).padStart(2, "0")}:${String(freeDate.getMinutes()).padStart(2, "0")}`;
        hasBotQueue = true;
      } else {
        freeAt = e.expectedExit;
      }

      // Fila column
      let filaHtml = "-";
      if (e.nexts > 0) {
        filaHtml = `<span class="has-next clickable" onclick="showQueueInfo('${escapeHtml(e.code)}', '${escapeHtml(e.name)}')">+${e.nexts} 🔍</span>`;
      }

      return `
      <tr class="${rowClass}" data-code="${escapeHtml(e.code)}" data-respawn="${escapeHtml(e.name)}" data-player="${escapeHtml(e.occupiedBy)}" data-voc="${vocClass}" data-level="${level}" data-remaining="${e.remainingMinutes}" data-exit="${freeAt}">
        <td class="code"><a href="/respawn/${encodeURIComponent(e.code)}" class="respawn-link">${escapeHtml(e.code)}</a></td>
        <td class="respawn-name"><a href="/respawn/${encodeURIComponent(e.code)}" class="respawn-link">${escapeHtml(e.name)}</a></td>
        <td class="player-cell">${playerHtml}</td>
        <td class="time-cell">
          <div class="time-info">
            <span class="elapsed">${e.elapsedFormatted}</span>
            <span class="separator">/</span>
            <span class="total">${e.totalFormatted}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${Math.min(100, e.progressPercent)}%; background: ${pColor};"></div>
          </div>
        </td>
        <td class="remaining ${timeUp ? "entry-window-text" : e.isAlmostDone ? "almost-text" : ""}">
          ${e.isEntryWindow ? "TROCANDO" : timeUp ? `SAINDO (+${e.elapsedMinutes - e.totalMinutes}min)` : e.remainingFormatted}
        </td>
        <td class="exit-time ${timeUp ? "entry-window-text" : e.isAlmostDone ? "almost-text" : ""}">
          ${hasBotQueue ? freeAt + ' <span class="queue-indicator">+fila</span>' : e.nexts > 0 ? '<span class="queue-indicator">+' + e.nexts + ' fila</span>' : freeAt}
        </td>
        <td class="nexts">${filaHtml}</td>
        <td class="status">${statusBadge(e)}</td>
      </tr>`;
    })
    .join("");

  const entryWindow = data.entries.filter((e) => e.isEntryWindow);
  const leaving = data.entries.filter((e) => e.elapsedMinutes >= e.totalMinutes && !e.isEntryWindow);
  const almostDone = data.entries.filter((e) => e.isAlmostDone);
  const active = data.entries.filter((e) => e.status === "active" && !e.isAlmostDone);

  // Reservations on free respawns (use code-aware matching)
  const freeReservations = activeReservations.filter((r) => {
    // Check if this reservation's respawn is currently occupied
    const isOccupied = data.entries.some((e) => {
      const matchingRes = findReservationsForRespawnByCode(e.code, e.name, [r], data.catalog);
      return matchingRes.length > 0;
    });
    return !isOccupied;
  });

  const freeResRows = freeReservations
    .map((r) => {
      // Try to resolve the code from catalog
      const match = matchRespawnName(r.respawnName, data.catalog);
      const codeHtml = match
        ? `<span class="code">${escapeHtml(match.code)}</span> `
        : '';

      const badge = r.isActiveNow
        ? '<span class="res-badge active">ATIVO</span>'
        : `<span class="res-badge upcoming">em ${r.minutesUntilStart}min</span>`;
      return `<tr>
        <td><span class="res-type-badge ${r.type}">${r.type.toUpperCase()}</span></td>
        <td class="respawn-name">${codeHtml}${escapeHtml(r.respawnName)}${match ? ` <span style="color:#52525b;font-size:0.8em">(${escapeHtml(match.catalogName)})</span>` : ''}</td>
        <td class="player">${escapeHtml(r.player)}</td>
        <td class="time-cell">${r.entryTime} ~ ${r.exitTime}</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");

  // Free respawns
  const freeRows = data.freeRespawns
    .map(
      (r) => `<tr><td class="code">${escapeHtml(r.code)}</td><td>${escapeHtml(r.name)}</td></tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Crusaders - Respawn Monitor</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0b0d17;
      color: #d4d4d8;
      min-height: 100vh;
    }

    .container { max-width: 1400px; margin: 0 auto; padding: 20px; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 0;
      border-bottom: 1px solid #1e2030;
      margin-bottom: 24px;
    }

    h1 { font-size: 1.5em; font-weight: 700; color: #f4f4f5; }
    h1 span { color: #818cf8; }
    .meta { font-size: 0.85em; color: #71717a; text-align: right; }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 12px;
      margin-bottom: 24px;
    }

    .stat-card {
      background: #111322;
      border: 1px solid #1e2030;
      border-radius: 12px;
      padding: 14px 18px;
    }

    .stat-card .label { font-size: 0.75em; color: #71717a; margin-bottom: 4px; }
    .stat-card .value { font-size: 1.6em; font-weight: 700; }
    .stat-card.total .value { color: #818cf8; }
    .stat-card.active .value { color: #34d399; }
    .stat-card.almost .value { color: #fbbf24; }
    .stat-card.switching .value { color: #a78bfa; }
    .stat-card.free .value { color: #60a5fa; }
    .stat-card.reserved .value { color: #c084fc; }

    .section-title {
      color: #a1a1aa;
      font-size: 1.1em;
      font-weight: 600;
      margin: 28px 0 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-title .count {
      background: #1e2030;
      color: #818cf8;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.8em;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      background: #111322;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #1e2030;
    }

    thead th {
      background: #0f1122;
      color: #a1a1aa;
      font-weight: 600;
      font-size: 0.72em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid #1e2030;
    }

    tbody td {
      padding: 10px 14px;
      border-bottom: 1px solid #1a1c2e;
      font-size: 0.85em;
    }

    tbody tr:hover { background: #161830; }
    tbody tr:last-child td { border-bottom: none; }

    .code {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600;
      color: #818cf8;
      font-size: 0.85em;
    }

    .respawn-name { font-weight: 500; color: #f4f4f5; }
    .respawn-link { color: inherit; text-decoration: none; }
    .respawn-link:hover { text-decoration: underline; color: #818cf8; }
    .code .respawn-link:hover { color: #a5b4fc; }
    .player { color: #a78bfa; font-weight: 500; }
    .player-cell { min-width: 160px; }
    .player-name { color: #a78bfa; font-weight: 500; display: block; }
    .player-link { text-decoration: none; }
    .player-link:hover .player-name { text-decoration: underline; color: #c4b5fd; }
    .player-info { display: flex; align-items: center; gap: 6px; margin-top: 3px; }
    .player-level { color: #71717a; font-size: 0.75em; font-family: 'JetBrains Mono', monospace; }
    .player-guild { color: #52525b; font-size: 0.7em; }

    .voc-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 0.65em;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .voc-badge.ek { background: #7f1d1d; color: #fca5a5; }
    .voc-badge.rp { background: #14532d; color: #86efac; }
    .voc-badge.ms { background: #1e1b4b; color: #a5b4fc; }
    .voc-badge.ed { background: #422006; color: #fed7aa; }

    .time-cell { min-width: 160px; }

    .time-info {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 0.85em;
      margin-bottom: 6px;
    }

    .elapsed { color: #f4f4f5; font-weight: 600; }
    .separator { color: #52525b; margin: 0 2px; }
    .total { color: #71717a; }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: #1e2030;
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.5s ease;
    }

    .remaining {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600;
      font-size: 0.9em;
      color: #34d399;
    }

    .exit-time {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 700;
      font-size: 1em;
      color: #fbbf24;
    }

    .entry-window-text { color: #a78bfa !important; }
    .almost-text { color: #fbbf24 !important; }

    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 0.7em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .badge.ok { background: #064e3b; color: #34d399; }
    .badge.almost { background: #451a03; color: #fbbf24; }
    .badge.entry-window { background: #1e1b4b; color: #a78bfa; }

    .has-next {
      background: #312e81;
      color: #a5b4fc;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 600;
    }

    .nexts { text-align: center; }
    .queue-inline { font-size: 0.7em; color: #34d399; font-family: monospace; margin-top: 2px; }
    .status { text-align: center; }

    /* Filter bar */
    .filter-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
    .search-input { background: #111322; border: 1px solid #2e3150; color: #d4d4d8; padding: 8px 14px; border-radius: 8px; font-size: 0.85em; min-width: 220px; }
    .search-input:focus { outline: none; border-color: #818cf8; }
    .voc-filters { display: flex; gap: 4px; }
    .voc-filter-btn { background: #1e2030; color: #71717a; border: 1px solid #2e3150; padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 0.8em; font-weight: 600; }
    .voc-filter-btn:hover { background: #2e3150; }
    .voc-filter-btn.active { background: #312e81; color: #a5b4fc; border-color: #4338ca; }
    .sort-select { background: #111322; border: 1px solid #2e3150; color: #d4d4d8; padding: 8px 12px; border-radius: 8px; font-size: 0.8em; }

    .entry-window-row { background: #0f0a1a !important; }
    .entry-window-row:hover { background: #15102a !important; }
    .almost-row { background: #1a1505 !important; }
    .almost-row:hover { background: #221a08 !important; }

    /* Reservation styles */
    .res-player { color: #c084fc; font-weight: 500; font-size: 0.9em; }
    .res-time { color: #71717a; font-size: 0.75em; }
    .no-reserve { color: #3f3f46; }

    .res-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 0.65em;
      font-weight: 700;
      text-transform: uppercase;
    }
    .res-badge.active { background: #3b0764; color: #d8b4fe; }
    .res-badge.upcoming { background: #1e1b4b; color: #a5b4fc; }

    .res-type-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 8px;
      font-size: 0.7em;
      font-weight: 700;
    }
    .res-type-badge.solo { background: #1e3a5f; color: #7dd3fc; }
    .res-type-badge.pt { background: #3b1f5f; color: #d8b4fe; }

    .toggle-btn {
      background: #1e2030;
      color: #818cf8;
      border: 1px solid #2e3150;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.9em;
      font-weight: 500;
      margin-left: 12px;
    }
    .toggle-btn:hover { background: #2e3150; }

    .collapsible { margin-top: 12px; }

    .free-table {
      max-height: 400px;
      overflow-y: auto;
      border-radius: 12px;
    }

    .free-table table { font-size: 0.85em; }
    .free-table tbody td { padding: 8px 16px; }

    .footer {
      display: flex;
      justify-content: space-between;
      margin-top: 16px;
      font-size: 0.8em;
      color: #52525b;
    }

    .footer a { color: #818cf8; }

    .clickable { cursor: pointer; }
    .clickable:hover { filter: brightness(1.3); }

    .refresh-btn {
      background: #1e2030;
      color: #818cf8;
      border: 1px solid #2e3150;
      padding: 6px 16px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.8em;
      font-weight: 500;
      transition: all 0.2s;
    }
    .refresh-btn:hover { background: #2e3150; color: #a5b4fc; }
    .refresh-btn:active { transform: scale(0.96); }

    .header-actions { display: flex; gap: 8px; align-items: center; }
    .refresh-page-btn {
      background: #111322;
      color: #818cf8;
      border: 1px solid #2e3150;
      padding: 8px 16px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .refresh-page-btn:hover { background: #1e2030; border-color: #818cf8; }
    .refresh-page-btn:active { transform: scale(0.96); }
    .refresh-page-btn.loading { opacity: 0.6; pointer-events: none; }

    /* Modal */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      justify-content: center;
      align-items: center;
    }
    .modal-overlay.active { display: flex; }

    .modal {
      background: #111322;
      border: 1px solid #2e3150;
      border-radius: 16px;
      padding: 24px;
      max-width: 520px;
      width: 90%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }

    .modal h2 {
      color: #f4f4f5;
      font-size: 1.1em;
      margin-bottom: 4px;
    }

    .modal .modal-code {
      color: #818cf8;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85em;
      margin-bottom: 16px;
    }

    .modal .queue-loading {
      text-align: center;
      padding: 30px;
      color: #71717a;
    }

    .modal .queue-loading .spinner {
      display: inline-block;
      width: 24px; height: 24px;
      border: 3px solid #2e3150;
      border-top-color: #818cf8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 12px;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .modal .queue-item {
      background: #0f1122;
      border: 1px solid #1e2030;
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }

    .modal .queue-item .queue-pos {
      color: #818cf8;
      font-weight: 700;
      font-size: 0.8em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .modal .queue-item .queue-player {
      color: #a78bfa;
      font-weight: 600;
      font-size: 1em;
      margin: 4px 0;
    }

    .modal .queue-item .queue-time {
      color: #71717a;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.85em;
    }

    .modal .queue-summary {
      background: #0b0d17;
      border: 1px solid #2e3150;
      border-radius: 10px;
      padding: 14px 18px;
      margin-top: 16px;
    }

    .modal .queue-summary .summary-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 6px;
    }

    .modal .queue-summary .summary-label {
      color: #71717a;
      font-size: 0.85em;
    }

    .modal .queue-summary .summary-value {
      color: #f4f4f5;
      font-weight: 600;
      font-size: 0.9em;
      font-family: 'JetBrains Mono', monospace;
    }

    .modal .queue-summary .free-at {
      color: #34d399;
      font-weight: 700;
      font-size: 1.1em;
    }

    .modal .close-btn {
      background: #1e2030;
      color: #a1a1aa;
      border: 1px solid #2e3150;
      padding: 8px 20px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85em;
      margin-top: 16px;
      display: block;
      width: 100%;
      text-align: center;
    }
    .modal .close-btn:hover { background: #2e3150; color: #f4f4f5; }

    .modal .error-msg {
      color: #f87171;
      text-align: center;
      padding: 20px;
    }

    .bot-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75em;
      color: #71717a;
      margin-top: 4px;
    }

    .queue-indicator { font-size: 0.65em; color: #818cf8; font-weight: 400; }

    .theme-toggle-btn {
      background: #111322;
      border: 1px solid #2e3150;
      padding: 8px 12px;
      border-radius: 10px;
      cursor: pointer;
      font-size: 1em;
      line-height: 1;
      transition: all 0.2s;
    }
    .theme-toggle-btn:hover { background: #1e2030; border-color: #818cf8; }

    @media (max-width: 900px) {
      .stats-row { grid-template-columns: repeat(3, 1fr); }
      .container { padding: 12px; }
      tbody td { padding: 6px 8px; font-size: 0.78em; }
    }

    /* ========= Light Theme ========= */
    body.light { background: #f5f7fa; color: #374151; }
    body.light header { border-color: #e5e7eb; }
    body.light h1 { color: #111827; }
    body.light h1 span { color: #6366f1; }
    body.light .meta { color: #9ca3af; }
    body.light .stat-card { background: #fff; border-color: #e5e7eb; }
    body.light .stat-card .label { color: #9ca3af; }
    body.light .stat-card.total .value { color: #6366f1; }
    body.light .stat-card.active .value { color: #059669; }
    body.light .stat-card.almost .value { color: #d97706; }
    body.light .stat-card.switching .value { color: #7c3aed; }
    body.light .stat-card.free .value { color: #2563eb; }
    body.light .stat-card.reserved .value { color: #9333ea; }
    body.light .section-title { color: #6b7280; }
    body.light .section-title .count { background: #e5e7eb; color: #6366f1; }
    body.light table { background: #fff; border-color: #e5e7eb; }
    body.light thead th { background: #f9fafb; color: #6b7280; border-color: #e5e7eb; }
    body.light tbody td { border-color: #f3f4f6; }
    body.light tbody tr:hover { background: #f9fafb; }
    body.light .code { color: #6366f1; }
    body.light .respawn-name { color: #111827; }
    body.light .respawn-link:hover { color: #6366f1; }
    body.light .player-name { color: #7c3aed; }
    body.light .player-link:hover .player-name { color: #6d28d9; }
    body.light .player-level { color: #9ca3af; }
    body.light .player-guild { color: #d1d5db; }
    body.light .voc-badge.ek { background: #fee2e2; color: #dc2626; }
    body.light .voc-badge.rp { background: #d1fae5; color: #059669; }
    body.light .voc-badge.ms { background: #e0e7ff; color: #4338ca; }
    body.light .voc-badge.ed { background: #ffedd5; color: #c2410c; }
    body.light .elapsed { color: #111827; }
    body.light .separator { color: #d1d5db; }
    body.light .total { color: #9ca3af; }
    body.light .progress-bar { background: #e5e7eb; }
    body.light .remaining { color: #059669; }
    body.light .exit-time { color: #d97706; }
    body.light .queue-indicator { color: #6366f1; }
    body.light .entry-window-text { color: #7c3aed !important; }
    body.light .almost-text { color: #d97706 !important; }
    body.light .badge.ok { background: #d1fae5; color: #059669; }
    body.light .badge.almost { background: #fef3c7; color: #d97706; }
    body.light .badge.entry-window { background: #ede9fe; color: #7c3aed; }
    body.light .has-next { background: #e0e7ff; color: #4338ca; }
    body.light .queue-inline { color: #059669; }
    body.light .search-input { background: #fff; border-color: #d1d5db; color: #374151; }
    body.light .search-input:focus { border-color: #6366f1; }
    body.light .voc-filter-btn { background: #e5e7eb; color: #6b7280; border-color: #d1d5db; }
    body.light .voc-filter-btn:hover { background: #d1d5db; }
    body.light .voc-filter-btn.active { background: #e0e7ff; color: #4338ca; border-color: #6366f1; }
    body.light .sort-select { background: #fff; border-color: #d1d5db; color: #374151; }
    body.light .entry-window-row { background: #f5f0ff !important; }
    body.light .entry-window-row:hover { background: #ede5ff !important; }
    body.light .almost-row { background: #fffbeb !important; }
    body.light .almost-row:hover { background: #fef3c7 !important; }
    body.light .res-badge.active { background: #f3e8ff; color: #9333ea; }
    body.light .res-badge.upcoming { background: #e0e7ff; color: #4338ca; }
    body.light .res-type-badge.solo { background: #e0f2fe; color: #0284c7; }
    body.light .res-type-badge.pt { background: #f3e8ff; color: #9333ea; }
    body.light .toggle-btn { background: #e5e7eb; color: #6366f1; border-color: #d1d5db; }
    body.light .toggle-btn:hover { background: #d1d5db; }
    body.light .footer { color: #d1d5db; }
    body.light .footer a { color: #6366f1; }
    body.light .refresh-btn { background: #e5e7eb; color: #6366f1; border-color: #d1d5db; }
    body.light .refresh-btn:hover { background: #d1d5db; color: #4338ca; }
    body.light .refresh-page-btn { background: #fff; color: #6366f1; border-color: #d1d5db; }
    body.light .refresh-page-btn:hover { background: #e5e7eb; border-color: #6366f1; }
    body.light .theme-toggle-btn { background: #fff; border-color: #d1d5db; }
    body.light .theme-toggle-btn:hover { background: #e5e7eb; border-color: #6366f1; }
    body.light .modal-overlay { background: rgba(0,0,0,0.3); }
    body.light .modal { background: #fff; border-color: #e5e7eb; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
    body.light .modal h2 { color: #111827; }
    body.light .modal .modal-code { color: #6366f1; }
    body.light .modal .queue-loading { color: #9ca3af; }
    body.light .modal .queue-loading .spinner { border-color: #e5e7eb; border-top-color: #6366f1; }
    body.light .modal .queue-item { background: #f9fafb; border-color: #e5e7eb; }
    body.light .modal .queue-item .queue-pos { color: #6366f1; }
    body.light .modal .queue-item .queue-player { color: #7c3aed; }
    body.light .modal .queue-item .queue-time { color: #9ca3af; }
    body.light .modal .queue-summary { background: #f5f7fa; border-color: #e5e7eb; }
    body.light .modal .queue-summary .summary-label { color: #9ca3af; }
    body.light .modal .queue-summary .summary-value { color: #111827; }
    body.light .modal .queue-summary .free-at { color: #059669; }
    body.light .modal .close-btn { background: #e5e7eb; color: #6b7280; border-color: #d1d5db; }
    body.light .modal .close-btn:hover { background: #d1d5db; color: #111827; }
    body.light .modal .error-msg { color: #dc2626; }
    body.light .bot-indicator { color: #9ca3af; }
    body.light .res-player { color: #9333ea; }
    body.light .no-reserve { color: #d1d5db; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1><span>Crusaders</span> Respawn Monitor</h1>
      <div class="header-actions">
        <button class="theme-toggle-btn" id="themeToggle" onclick="toggleTheme()" title="Alternar tema claro/escuro">
          <span id="themeIcon">&#9728;</span>
        </button>
        <button class="refresh-page-btn" id="refreshBtn" onclick="refreshPage()">
          &#x21bb; Atualizar
        </button>
        <div class="meta">
          TS: ${data.timestamp}<br>
          Reservas: ${reservations ? reservations.all.length + " cadastradas" : "indisponivel"}<br>
          Atualizado: <span id="lastUpdate">${data.fetchedAt.toLocaleTimeString("pt-BR")}</span>
          <div class="bot-indicator" id="botStatus">
            <span id="botText">CrusaderBot: ${lastBotContact ? "ultimo contato " + lastBotContact.toLocaleTimeString("pt-BR") : "sem contato"}</span>
          </div>
        </div>
      </div>
    </header>

    <div class="stats-row">
      <div class="stat-card total">
        <div class="label">Ocupados</div>
        <div class="value">${data.totalRespawns}</div>
      </div>
      <div class="stat-card active">
        <div class="label">Ativos</div>
        <div class="value">${active.length}</div>
      </div>
      <div class="stat-card almost">
        <div class="label">Acabando</div>
        <div class="value">${almostDone.length}</div>
      </div>
      <div class="stat-card switching">
        <div class="label">Trocando</div>
        <div class="value">${entryWindow.length + leaving.length}</div>
      </div>
      <div class="stat-card free">
        <div class="label">Livres</div>
        <div class="value">${data.freeRespawns.length}</div>
      </div>
      <div class="stat-card reserved">
        <div class="label">Reservas Ativas</div>
        <div class="value">${activeReservations.filter((r) => r.isActiveNow).length}</div>
      </div>
    </div>

    <div class="section-title">Respawns Ocupados <span class="count">${data.totalRespawns}</span></div>

    <div class="filter-bar">
      <input type="text" id="searchFilter" placeholder="Buscar jogador ou respawn..." class="search-input">
      <div class="voc-filters">
        <button class="voc-filter-btn active" data-voc="all">Todos</button>
        <button class="voc-filter-btn" data-voc="ek">EK</button>
        <button class="voc-filter-btn" data-voc="rp">RP</button>
        <button class="voc-filter-btn" data-voc="ms">MS</button>
        <button class="voc-filter-btn" data-voc="ed">ED</button>
      </div>
      <select id="sortSelect" class="sort-select">
        <option value="code">Ordenar: Code</option>
        <option value="remaining">Ordenar: Restante</option>
        <option value="level-desc">Ordenar: Level &#8595;</option>
        <option value="level-asc">Ordenar: Level &#8593;</option>
        <option value="exit">Ordenar: Livre as</option>
        <option value="respawn">Ordenar: Respawn</option>
      </select>
    </div>

    <table>
      <thead>
        <tr>
          <th>Code</th>
          <th>Respawn</th>
          <th>Jogador</th>
          <th>Tempo / Total</th>
          <th>Restante</th>
          <th>Livre as</th>
          <th>Fila</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#52525b;">Nenhum respawn ocupado</td></tr>'}
      </tbody>
    </table>

    ${
      freeReservations.length > 0
        ? `
    <div class="collapsible">
      <div class="section-title">
        Reservas em Respawns Livres <span class="count">${freeReservations.length}</span>
        <button class="toggle-btn" onclick="toggleSection('freeResTable')">
          Mostrar / Ocultar
        </button>
      </div>
      <div id="freeResTable" style="display:none;">
        <table>
          <thead>
            <tr><th>Tipo</th><th>Respawn</th><th>Reservado por</th><th>Horario</th><th>Status</th></tr>
          </thead>
          <tbody>${freeResRows}</tbody>
        </table>
      </div>
    </div>`
        : ""
    }

    <div class="collapsible">
      <div class="section-title">
        Respawns Livres <span class="count">${data.freeRespawns.length} / ${data.catalogTotal}</span>
        <button class="toggle-btn" onclick="toggleSection('freeTable')">
          Mostrar / Ocultar
        </button>
      </div>
      <div id="freeTable" class="free-table" style="display:none;">
        <table>
          <thead><tr><th>Code</th><th>Respawn</th></tr></thead>
          <tbody>
            ${freeRows || '<tr><td colspan="2" style="text-align:center;color:#52525b;">Todos ocupados</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>

    <div class="footer">
      <span>Auto-refresh: 5s | <a href="https://docs.google.com/spreadsheets/d/1_b1znU4lzmEFKEXBo0_plPen2muqHhEgFQApPnHuy-o/htmlview#gid=1898585368" target="_blank">Planilha de Reservas</a></span>
      <span>API: <a href="/api/respawns">respawns</a> | <a href="/api/stats">stats</a> | <a href="/api/clients">clients</a></span>
    </div>
  </div>

  <!-- Queue Detail Modal -->
  <div class="modal-overlay" id="queueModal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <h2 id="modalTitle">Detalhes da Fila</h2>
      <div class="modal-code" id="modalCode"></div>
      <div id="modalContent">
        <div class="queue-loading">
          <div class="spinner"></div>
          <div>Consultando CrusaderBot...</div>
        </div>
      </div>
      <button class="close-btn" onclick="closeModal()">Fechar</button>
    </div>
  </div>

  <script>
    var _currentModalCode = '';
    var _currentModalName = '';

    function renderQueueData(data) {
      var html = '';
      if (data.currentPlayer) {
        html += '<div class="queue-item">';
        html += '<div class="queue-pos">Ocupante Atual</div>';
        html += '<div class="queue-player">' + escapeHtml(data.currentPlayer) + '</div>';
        html += '<div class="queue-time">Claim: ' + data.claimTime + ' (' + data.claimMinutes + 'min)</div>';
        html += '</div>';
      }
      if (data.nexts && data.nexts.length > 0) {
        data.nexts.forEach(function(n) {
          html += '<div class="queue-item">';
          html += '<div class="queue-pos">Proximo #' + n.position + '</div>';
          html += '<div class="queue-player">' + escapeHtml(n.player) + '</div>';
          html += '<div class="queue-time">Claim: ' + n.claimTime + ' (' + n.claimMinutes + 'min)</div>';
          html += '</div>';
        });
      }
      html += '<div class="queue-summary">';
      html += '<div class="summary-row"><span class="summary-label">Tempo total na fila</span><span class="summary-value">' + data.totalQueueMinutes + ' min</span></div>';
      html += '<div class="summary-row"><span class="summary-label">Respawn livre as</span><span class="summary-value free-at">~' + data.freeAt + '</span></div>';
      html += '</div>';
      return html;
    }

    function fetchQueueInfo(code, force) {
      var url = '/api/respinfo/' + code;
      if (force) url += '?force=1';
      document.getElementById('modalContent').innerHTML = '<div class="queue-loading"><div class="spinner"></div><div>' + (force ? 'Atualizando do CrusaderBot...' : 'Consultando CrusaderBot...') + '</div></div>';

      fetch(url)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            document.getElementById('modalContent').innerHTML = '<div class="error-msg">' + data.error + '</div><div style="text-align:center;margin-top:12px;"><button class="refresh-btn" onclick="refreshQueue()">Tentar novamente</button></div>';
            document.getElementById('botText').textContent = 'CrusaderBot: sem resposta';
            return;
          }
          document.getElementById('botText').textContent = 'CrusaderBot: ultimo contato ' + new Date().toLocaleTimeString('pt-BR');
          var html = renderQueueData(data);
          html += '<div style="text-align:center;margin-top:12px;"><button class="refresh-btn" onclick="refreshQueue()">Atualizar fila</button></div>';
          document.getElementById('modalContent').innerHTML = html;
        })
        .catch(function(err) {
          document.getElementById('modalContent').innerHTML = '<div class="error-msg">Erro: ' + err.message + '</div><div style="text-align:center;margin-top:12px;"><button class="refresh-btn" onclick="refreshQueue()">Tentar novamente</button></div>';
          document.getElementById('botText').textContent = 'CrusaderBot: erro';
        });
    }

    function showQueueInfo(code, name) {
      _currentModalCode = code;
      _currentModalName = name;
      var modal = document.getElementById('queueModal');
      document.getElementById('modalTitle').textContent = name;
      document.getElementById('modalCode').textContent = 'Code: ' + code;
      modal.classList.add('active');
      fetchQueueInfo(code, false);
    }

    function refreshQueue() {
      if (_currentModalCode) {
        fetchQueueInfo(_currentModalCode, true);
      }
    }

    function closeModal() {
      document.getElementById('queueModal').classList.remove('active');
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Close modal on ESC
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
    });

    // --- Theme toggle ---
    function toggleTheme() {
      var isLight = document.body.classList.toggle('light');
      localStorage.setItem('dashTheme', isLight ? 'light' : 'dark');
      document.getElementById('themeIcon').innerHTML = isLight ? '&#9789;' : '&#9728;';
    }

    // Restore theme immediately
    (function() {
      if (localStorage.getItem('dashTheme') === 'light') {
        document.body.classList.add('light');
        document.getElementById('themeIcon').innerHTML = '&#9789;';
      }
    })();

    // --- Section toggle ---
    function toggleSection(id) {
      var el = document.getElementById(id);
      if (el) {
        el.style.display = el.style.display === 'none' ? 'block' : 'none';
        saveState();
      }
    }

    // --- State persistence ---
    function saveState() {
      try {
        var sortEl = document.getElementById('sortSelect');
        var searchEl = document.getElementById('searchFilter');
        var activeBtn = document.querySelector('.voc-filter-btn.active');
        var state = {
          sort: sortEl ? sortEl.value : 'code',
          search: searchEl ? searchEl.value : '',
          voc: activeBtn ? activeBtn.dataset.voc : 'all',
          freeExpanded: document.getElementById('freeTable') && document.getElementById('freeTable').style.display !== 'none' ? '1' : '0',
          freeResExpanded: document.getElementById('freeResTable') && document.getElementById('freeResTable').style.display !== 'none' ? '1' : '0'
        };
        localStorage.setItem('dashState', JSON.stringify(state));
      } catch(e) {}
    }

    function restoreState() {
      try {
        var raw = localStorage.getItem('dashState');
        if (!raw) return;
        var state = JSON.parse(raw);

        if (state.sort) {
          var sortEl = document.getElementById('sortSelect');
          if (sortEl) sortEl.value = state.sort;
        }

        if (state.search) {
          var searchEl = document.getElementById('searchFilter');
          if (searchEl) searchEl.value = state.search;
        }

        if (state.voc && state.voc !== 'all') {
          document.querySelectorAll('.voc-filter-btn').forEach(function(b) {
            b.classList.remove('active');
            if (b.dataset.voc === state.voc) b.classList.add('active');
          });
        }

        if (state.freeExpanded === '1') {
          var ft = document.getElementById('freeTable');
          if (ft) ft.style.display = 'block';
        }

        if (state.freeResExpanded === '1') {
          var frt = document.getElementById('freeResTable');
          if (frt) frt.style.display = 'block';
        }

        // Apply if any filter/sort was restored
        if (state.sort !== 'code' || state.search || (state.voc && state.voc !== 'all')) {
          applyFilters();
        }
      } catch(e) {}
    }

    // --- Filter and sort ---
    function applyFilters() {
      var search = document.getElementById('searchFilter').value.toLowerCase();
      var activeBtn = document.querySelector('.voc-filter-btn.active');
      var activeVoc = activeBtn ? activeBtn.dataset.voc : 'all';
      var sortBy = document.getElementById('sortSelect').value;

      var tbody = document.querySelector('table tbody');
      var rows = Array.from(tbody.querySelectorAll('tr'));

      rows.forEach(function(row) {
        var player = (row.dataset.player || '').toLowerCase();
        var respawn = (row.dataset.respawn || '').toLowerCase();
        var voc = row.dataset.voc || '';

        var matchSearch = !search || player.includes(search) || respawn.includes(search);
        var matchVoc = activeVoc === 'all' || voc === activeVoc;

        row.style.display = (matchSearch && matchVoc) ? '' : 'none';
      });

      var sorted = rows.sort(function(a, b) {
        switch(sortBy) {
          case 'remaining': return parseInt(a.dataset.remaining||'9999') - parseInt(b.dataset.remaining||'9999');
          case 'level-desc': return parseInt(b.dataset.level||'0') - parseInt(a.dataset.level||'0');
          case 'level-asc': return parseInt(a.dataset.level||'0') - parseInt(b.dataset.level||'0');
          case 'exit': return (a.dataset.exit||'').localeCompare(b.dataset.exit||'');
          case 'respawn': return (a.dataset.respawn||'').localeCompare(b.dataset.respawn||'');
          default: return (a.dataset.code||'').localeCompare(b.dataset.code||'', undefined, {numeric: true});
        }
      });
      sorted.forEach(function(row) { tbody.appendChild(row); });
    }

    document.getElementById('searchFilter').addEventListener('input', function() { applyFilters(); saveState(); });
    document.getElementById('sortSelect').addEventListener('change', function() { applyFilters(); saveState(); });
    document.querySelectorAll('.voc-filter-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.voc-filter-btn').forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        applyFilters();
        saveState();
      });
    });

    // --- Smart auto-refresh: pauses when modal is open ---
    var refreshInterval = 5000;
    var refreshTimer = null;
    var modalOpen = false;

    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(function() {
        if (!modalOpen) {
          saveState();
          window.location.reload();
        } else {
          scheduleRefresh();
        }
      }, refreshInterval);
    }

    // Manual refresh button
    function refreshPage() {
      var btn = document.getElementById('refreshBtn');
      if (btn) { btn.classList.add('loading'); btn.innerHTML = '&#x21bb; Atualizando...'; }
      saveState();
      window.location.reload();
    }

    // Override showQueueInfo to track modal state
    var _origShowQueueInfo = showQueueInfo;
    showQueueInfo = function(code, name) {
      modalOpen = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      _origShowQueueInfo(code, name);
    };

    var _origCloseModal = closeModal;
    closeModal = function() {
      modalOpen = false;
      _origCloseModal();
      scheduleRefresh();
    };

    // Restore state from previous page load, then start auto-refresh
    restoreState();
    scheduleRefresh();
  </script>
</body>
</html>`;
}

function renderRespawnDetailHTML(
  code: string,
  entry: RespawnEntry | null,
  respawnName: string,
  history: RespawnLogEntry[],
  botData: RespInfoResult | null,
  playerTibia: TibiaCharacter | null,
  resolvedCharName: string | null,
  reservations: ActiveReservation[],
): string {
  const pColor = entry ? progressColor(entry.progressPercent) : "#3498db";
  const timeUp = entry ? entry.elapsedMinutes >= entry.totalMinutes : false;

  // Vocation/level breakdown from history
  const vocBreakdown: Record<string, number> = {};
  const levelRanges: number[] = [];
  const playerVisits: Record<string, { count: number; vocation: string; level: number; lastSeen: string }> = {};

  for (const h of history) {
    const voc = h.vocationShort || "?";
    vocBreakdown[voc] = (vocBreakdown[voc] || 0) + 1;
    if (h.level > 0) levelRanges.push(h.level);
    const pKey = h.displayName.toLowerCase();
    if (!playerVisits[pKey]) {
      playerVisits[pKey] = { count: 0, vocation: voc, level: h.level, lastSeen: h.startedAt };
    }
    playerVisits[pKey].count++;
    if (h.startedAt > playerVisits[pKey].lastSeen) {
      playerVisits[pKey].lastSeen = h.startedAt;
      playerVisits[pKey].level = h.level;
      playerVisits[pKey].vocation = voc;
    }
  }

  const topPlayers = Object.entries(playerVisits)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);

  const minLevel = levelRanges.length > 0 ? Math.min(...levelRanges) : 0;
  const maxLevel = levelRanges.length > 0 ? Math.max(...levelRanges) : 0;
  const avgLevel = levelRanges.length > 0 ? Math.round(levelRanges.reduce((a, b) => a + b, 0) / levelRanges.length) : 0;

  // Voc pie data for simple bar chart
  const totalVoc = Object.values(vocBreakdown).reduce((a, b) => a + b, 0);
  const vocBars = Object.entries(vocBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([voc, count]) => {
      const pct = totalVoc > 0 ? Math.round((count / totalVoc) * 100) : 0;
      const vocColorMap: Record<string, string> = { EK: "#fca5a5", RP: "#86efac", MS: "#a5b4fc", ED: "#fed7aa" };
      const bgMap: Record<string, string> = { EK: "#7f1d1d", RP: "#14532d", MS: "#1e1b4b", ED: "#422006" };
      return `<div class="voc-bar-row">
        <span class="voc-bar-label" style="color:${vocColorMap[voc] || '#71717a'}">${escapeHtml(voc)}</span>
        <div class="voc-bar-track"><div class="voc-bar-fill" style="width:${pct}%;background:${bgMap[voc] || '#2e3150'}"></div></div>
        <span class="voc-bar-pct">${pct}% (${count})</span>
      </div>`;
    })
    .join("");

  // Current occupant section
  let occupantHtml = '<div class="detail-empty">Respawn livre</div>';
  if (entry) {
    let playerInfoHtml = "";
    if (playerTibia && resolvedCharName) {
      const sv = shortVocation(playerTibia.vocation);
      playerInfoHtml = `
        <div class="detail-player-meta">
          <span class="voc-badge ${sv.toLowerCase()}">${sv}</span>
          <span class="detail-level">Level ${playerTibia.level}</span>
          ${playerTibia.guild ? `<span class="detail-guild">${escapeHtml(playerTibia.guild)}</span>` : ""}
          <span class="detail-world">${escapeHtml(playerTibia.world)}</span>
        </div>`;
    }

    const tibiaUrl = resolvedCharName
      ? `https://www.tibia.com/community/?subtopic=characters&name=${encodeURIComponent(resolvedCharName)}`
      : `https://www.tibia.com/community/?subtopic=characters&name=${encodeURIComponent(entry.occupiedBy)}`;

    occupantHtml = `
      <div class="detail-occupant">
        <a href="${tibiaUrl}" target="_blank" class="detail-player-name">${escapeHtml(entry.occupiedBy)}</a>
        ${playerInfoHtml}
        <div class="detail-time-row">
          <div class="detail-time-block">
            <span class="detail-time-label">Tempo</span>
            <span class="detail-time-value">${entry.elapsedFormatted} / ${entry.totalFormatted}</span>
          </div>
          <div class="detail-time-block">
            <span class="detail-time-label">Restante</span>
            <span class="detail-time-value ${timeUp ? 'entry-window-text' : entry.isAlmostDone ? 'almost-text' : 'remaining'}">${
              entry.isEntryWindow ? "TROCANDO" : timeUp ? `SAINDO (+${entry.elapsedMinutes - entry.totalMinutes}min)` : entry.remainingFormatted
            }</span>
          </div>
          <div class="detail-time-block">
            <span class="detail-time-label">Sai as</span>
            <span class="detail-time-value exit-time">${entry.expectedExit}</span>
          </div>
        </div>
        <div class="progress-bar" style="margin-top:12px;height:6px;">
          <div class="progress-fill" style="width:${Math.min(100, entry.progressPercent)}%;background:${pColor};"></div>
        </div>
        <div style="margin-top:8px;text-align:right;">${statusBadge(entry)}</div>
      </div>`;
  }

  // Queue section
  let queueHtml = "";
  if (entry && entry.nexts > 0) {
    queueHtml = `<div class="detail-section">
      <h3 class="detail-section-title">Fila <span class="count">+${entry.nexts}</span></h3>
      <div id="queueContent">`;

    if (botData) {
      if (botData.currentPlayer) {
        queueHtml += `<div class="queue-item">
          <div class="queue-pos">Ocupante Atual</div>
          <div class="queue-player">${escapeHtml(botData.currentPlayer)}</div>
          <div class="queue-time">Claim: ${botData.claimTime} (${botData.claimMinutes}min)</div>
        </div>`;
      }
      if (botData.nexts && botData.nexts.length > 0) {
        for (const n of botData.nexts) {
          queueHtml += `<div class="queue-item">
            <div class="queue-pos">Proximo #${n.position}</div>
            <div class="queue-player">${escapeHtml(n.player)}</div>
            <div class="queue-time">Claim: ${n.claimTime} (${n.claimMinutes}min)</div>
          </div>`;
        }
      }
      queueHtml += `<div class="queue-summary">
        <div class="summary-row"><span class="summary-label">Tempo total na fila</span><span class="summary-value">${botData.totalQueueMinutes} min</span></div>
        <div class="summary-row"><span class="summary-label">Respawn livre as</span><span class="summary-value free-at">~${botData.freeAt}</span></div>
      </div>`;
    } else {
      queueHtml += `<div class="detail-empty">Dados do bot indisponiveis. <button class="toggle-btn" onclick="loadQueue('${escapeHtml(code)}')">Consultar Bot</button></div>`;
    }

    queueHtml += `</div></div>`;
  }

  // Reservations for this respawn
  let reservationHtml = "";
  if (reservations.length > 0) {
    const resRows = reservations.map((r) => {
      const badge = r.isActiveNow
        ? '<span class="res-badge active">ATIVO</span>'
        : `<span class="res-badge upcoming">em ${r.minutesUntilStart}min</span>`;
      return `<tr>
        <td><span class="res-type-badge ${r.type}">${r.type.toUpperCase()}</span></td>
        <td>${escapeHtml(r.player)}</td>
        <td>${r.entryTime} ~ ${r.exitTime}</td>
        <td>${badge}</td>
      </tr>`;
    }).join("");

    reservationHtml = `<div class="detail-section">
      <h3 class="detail-section-title">Reservas <span class="count">${reservations.length}</span></h3>
      <table class="detail-table">
        <thead><tr><th>Tipo</th><th>Jogador</th><th>Horario</th><th>Status</th></tr></thead>
        <tbody>${resRows}</tbody>
      </table>
    </div>`;
  }

  // History section
  let historyHtml = "";
  if (history.length > 0) {
    const recentHistory = history.slice(0, 20);
    const histRows = recentHistory.map((h) => {
      const startDate = new Date(h.startedAt);
      const dateStr = startDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
      const timeStr = startDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const duration = h.endedAt
        ? Math.round((new Date(h.endedAt).getTime() - startDate.getTime()) / 60000) + "min"
        : "ativo";
      const sv = h.vocationShort || "?";
      return `<tr>
        <td class="hist-date">${dateStr} ${timeStr}</td>
        <td><a href="https://www.tibia.com/community/?subtopic=characters&name=${encodeURIComponent(h.charNames[0] || h.displayName)}" target="_blank" class="player-link"><span class="player-name">${escapeHtml(h.displayName)}</span></a></td>
        <td><span class="voc-badge ${sv.toLowerCase()}">${sv}</span></td>
        <td class="hist-level">${h.level > 0 ? h.level : "-"}</td>
        <td class="hist-duration">${duration}</td>
      </tr>`;
    }).join("");

    historyHtml = `<div class="detail-section">
      <h3 class="detail-section-title">Historico <span class="count">${history.length} registros</span></h3>
      <div class="detail-table-scroll">
        <table class="detail-table">
          <thead><tr><th>Data</th><th>Jogador</th><th>Voc</th><th>Level</th><th>Duracao</th></tr></thead>
          <tbody>${histRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // Stats section
  let statsHtml = "";
  if (history.length > 0) {
    const topPlayersHtml = topPlayers.map(([name, data]) => {
      return `<div class="top-player-row">
        <span class="top-player-name">${escapeHtml(name)}</span>
        <span class="voc-badge ${data.vocation.toLowerCase()}">${data.vocation}</span>
        <span class="top-player-level">Lv${data.level}</span>
        <span class="top-player-count">${data.count}x</span>
      </div>`;
    }).join("");

    statsHtml = `<div class="detail-section">
      <h3 class="detail-section-title">Estatisticas</h3>
      <div class="stats-grid">
        <div class="stat-detail-card">
          <div class="label">Total de Usos</div>
          <div class="value" style="color:#818cf8">${history.length}</div>
        </div>
        <div class="stat-detail-card">
          <div class="label">Jogadores Unicos</div>
          <div class="value" style="color:#34d399">${Object.keys(playerVisits).length}</div>
        </div>
        <div class="stat-detail-card">
          <div class="label">Level Medio</div>
          <div class="value" style="color:#fbbf24">${avgLevel}</div>
        </div>
        <div class="stat-detail-card">
          <div class="label">Level Range</div>
          <div class="value" style="color:#a78bfa;font-size:1em">${minLevel} ~ ${maxLevel}</div>
        </div>
      </div>

      <div class="stats-columns">
        <div class="stats-col">
          <h4 class="stats-col-title">Vocacoes</h4>
          ${vocBars || '<div class="detail-empty">Sem dados</div>'}
        </div>
        <div class="stats-col">
          <h4 class="stats-col-title">Top Jogadores</h4>
          ${topPlayersHtml || '<div class="detail-empty">Sem dados</div>'}
        </div>
      </div>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(code)} - ${escapeHtml(respawnName)} | Crusaders</title>
  <meta http-equiv="refresh" content="10">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0b0d17;
      color: #d4d4d8;
      min-height: 100vh;
    }

    .container { max-width: 900px; margin: 0 auto; padding: 20px; }

    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #818cf8;
      text-decoration: none;
      font-size: 0.85em;
      font-weight: 500;
      margin-bottom: 20px;
    }
    .back-link:hover { color: #a5b4fc; text-decoration: underline; }

    .detail-header {
      background: #111322;
      border: 1px solid #1e2030;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }

    .detail-header h1 {
      font-size: 1.4em;
      color: #f4f4f5;
      margin-bottom: 4px;
    }

    .detail-code {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      color: #818cf8;
      font-size: 1.8em;
      font-weight: 700;
      display: inline-block;
      margin-right: 12px;
      vertical-align: middle;
    }

    .detail-name {
      font-size: 1.3em;
      color: #f4f4f5;
      font-weight: 600;
      vertical-align: middle;
    }

    .detail-occupant {
      background: #0f1122;
      border: 1px solid #1e2030;
      border-radius: 12px;
      padding: 18px;
      margin-top: 16px;
    }

    .detail-player-name {
      color: #a78bfa;
      font-weight: 600;
      font-size: 1.15em;
      text-decoration: none;
    }
    .detail-player-name:hover { text-decoration: underline; color: #c4b5fd; }

    .detail-player-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
    }

    .detail-level { color: #d4d4d8; font-family: 'JetBrains Mono', monospace; font-size: 0.9em; font-weight: 600; }
    .detail-guild { color: #71717a; font-size: 0.85em; }
    .detail-world { color: #52525b; font-size: 0.8em; }

    .detail-time-row {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
      margin-top: 16px;
    }

    .detail-time-block {
      background: #0b0d17;
      border: 1px solid #1a1c2e;
      border-radius: 10px;
      padding: 12px 14px;
      text-align: center;
    }

    .detail-time-label {
      display: block;
      font-size: 0.7em;
      color: #71717a;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 4px;
    }

    .detail-time-value {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-size: 1.1em;
      font-weight: 700;
      color: #f4f4f5;
    }

    .progress-bar {
      width: 100%;
      height: 4px;
      background: #1e2030;
      border-radius: 2px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.5s ease;
    }

    .remaining { color: #34d399; }
    .exit-time { color: #fbbf24; }
    .entry-window-text { color: #a78bfa !important; }
    .almost-text { color: #fbbf24 !important; }

    .badge {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 20px;
      font-size: 0.7em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .badge.ok { background: #064e3b; color: #34d399; }
    .badge.almost { background: #451a03; color: #fbbf24; }
    .badge.entry-window { background: #1e1b4b; color: #a78bfa; }

    .voc-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 0.65em;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .voc-badge.ek { background: #7f1d1d; color: #fca5a5; }
    .voc-badge.rp { background: #14532d; color: #86efac; }
    .voc-badge.ms { background: #1e1b4b; color: #a5b4fc; }
    .voc-badge.ed { background: #422006; color: #fed7aa; }

    .detail-section {
      background: #111322;
      border: 1px solid #1e2030;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .detail-section-title {
      color: #a1a1aa;
      font-size: 1em;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .detail-section-title .count {
      background: #1e2030;
      color: #818cf8;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.8em;
    }

    .detail-empty {
      text-align: center;
      padding: 20px;
      color: #52525b;
      font-size: 0.9em;
    }

    .detail-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85em;
    }
    .detail-table thead th {
      background: #0f1122;
      color: #a1a1aa;
      font-weight: 600;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #1e2030;
    }
    .detail-table tbody td {
      padding: 8px 12px;
      border-bottom: 1px solid #1a1c2e;
    }
    .detail-table tbody tr:hover { background: #161830; }
    .detail-table tbody tr:last-child td { border-bottom: none; }

    .detail-table-scroll { max-height: 400px; overflow-y: auto; border-radius: 8px; }

    .hist-date { color: #71717a; font-family: 'JetBrains Mono', monospace; font-size: 0.85em; white-space: nowrap; }
    .hist-level { font-family: 'JetBrains Mono', monospace; color: #d4d4d8; }
    .hist-duration { font-family: 'JetBrains Mono', monospace; color: #71717a; }

    .player-link { text-decoration: none; }
    .player-link:hover .player-name { text-decoration: underline; color: #c4b5fd; }
    .player-name { color: #a78bfa; font-weight: 500; }

    .queue-item {
      background: #0f1122;
      border: 1px solid #1e2030;
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 8px;
    }
    .queue-pos { color: #818cf8; font-weight: 700; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.05em; }
    .queue-player { color: #a78bfa; font-weight: 600; font-size: 1em; margin: 4px 0; }
    .queue-time { color: #71717a; font-family: 'JetBrains Mono', monospace; font-size: 0.85em; }

    .queue-summary {
      background: #0b0d17;
      border: 1px solid #2e3150;
      border-radius: 10px;
      padding: 14px 18px;
      margin-top: 12px;
    }
    .summary-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
    .summary-label { color: #71717a; font-size: 0.85em; }
    .summary-value { color: #f4f4f5; font-weight: 600; font-size: 0.9em; font-family: 'JetBrains Mono', monospace; }
    .free-at { color: #34d399; font-weight: 700; font-size: 1.1em; }

    .res-badge { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 0.65em; font-weight: 700; text-transform: uppercase; }
    .res-badge.active { background: #3b0764; color: #d8b4fe; }
    .res-badge.upcoming { background: #1e1b4b; color: #a5b4fc; }
    .res-type-badge { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 0.7em; font-weight: 700; }
    .res-type-badge.solo { background: #1e3a5f; color: #7dd3fc; }
    .res-type-badge.pt { background: #3b1f5f; color: #d8b4fe; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 18px;
    }

    .stat-detail-card {
      background: #0f1122;
      border: 1px solid #1a1c2e;
      border-radius: 10px;
      padding: 12px 14px;
      text-align: center;
    }
    .stat-detail-card .label { font-size: 0.7em; color: #71717a; margin-bottom: 4px; }
    .stat-detail-card .value { font-size: 1.4em; font-weight: 700; }

    .stats-columns {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .stats-col { }
    .stats-col-title { color: #a1a1aa; font-size: 0.85em; font-weight: 600; margin-bottom: 10px; }

    .voc-bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
    .voc-bar-label { width: 28px; font-weight: 700; font-size: 0.8em; text-align: right; }
    .voc-bar-track { flex: 1; height: 20px; background: #0b0d17; border-radius: 6px; overflow: hidden; }
    .voc-bar-fill { height: 100%; border-radius: 6px; transition: width 0.5s ease; }
    .voc-bar-pct { font-size: 0.75em; color: #71717a; font-family: 'JetBrains Mono', monospace; min-width: 64px; }

    .top-player-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #1a1c2e; }
    .top-player-row:last-child { border-bottom: none; }
    .top-player-name { flex: 1; color: #d4d4d8; font-size: 0.85em; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .top-player-level { color: #71717a; font-size: 0.75em; font-family: 'JetBrains Mono', monospace; }
    .top-player-count { color: #818cf8; font-size: 0.8em; font-weight: 700; font-family: 'JetBrains Mono', monospace; }

    .toggle-btn {
      background: #1e2030;
      color: #818cf8;
      border: 1px solid #2e3150;
      padding: 6px 14px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 500;
    }
    .toggle-btn:hover { background: #2e3150; }

    .has-next {
      background: #312e81;
      color: #a5b4fc;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.85em;
      font-weight: 600;
    }

    @media (max-width: 700px) {
      .detail-time-row { grid-template-columns: 1fr; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .stats-columns { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">&larr; Voltar ao Monitor</a>

    <div class="detail-header">
      <div>
        <span class="detail-code">${escapeHtml(code)}</span>
        <span class="detail-name">${escapeHtml(respawnName)}</span>
      </div>
      ${occupantHtml}
    </div>

    ${queueHtml}
    ${reservationHtml}
    ${statsHtml}
    ${historyHtml}
  </div>

  <script>
    function loadQueue(code) {
      var el = document.getElementById('queueContent');
      if (!el) return;
      el.innerHTML = '<div class="detail-empty">Consultando CrusaderBot...</div>';
      fetch('/api/respinfo/' + code)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            el.innerHTML = '<div class="detail-empty" style="color:#f87171">' + data.error + '</div>';
            return;
          }
          var html = '';
          if (data.currentPlayer) {
            html += '<div class="queue-item"><div class="queue-pos">Ocupante Atual</div><div class="queue-player">' + escapeHtml(data.currentPlayer) + '</div><div class="queue-time">Claim: ' + data.claimTime + ' (' + data.claimMinutes + 'min)</div></div>';
          }
          if (data.nexts && data.nexts.length > 0) {
            data.nexts.forEach(function(n) {
              html += '<div class="queue-item"><div class="queue-pos">Proximo #' + n.position + '</div><div class="queue-player">' + escapeHtml(n.player) + '</div><div class="queue-time">Claim: ' + n.claimTime + ' (' + n.claimMinutes + 'min)</div></div>';
            });
          }
          html += '<div class="queue-summary"><div class="summary-row"><span class="summary-label">Tempo total na fila</span><span class="summary-value">' + data.totalQueueMinutes + ' min</span></div><div class="summary-row"><span class="summary-label">Respawn livre as</span><span class="summary-value free-at">~' + data.freeAt + '</span></div></div>';
          el.innerHTML = html;
        })
        .catch(function(err) {
          el.innerHTML = '<div class="detail-empty" style="color:#f87171">Erro: ' + err.message + '</div>';
        });
    }

    function escapeHtml(str) {
      var div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
}

function renderPlayerDetailHTML(
  displayName: string,
  profile: PlayerProfile | null,
  tibiaFull: TibiaCharacterFull | null,
  resolvedCharName: string | null,
  playerHistory: RespawnLogEntry[],
): string {
  const sv = tibiaFull ? shortVocation(tibiaFull.vocation) : (profile?.vocationShort || "?");
  const svLower = sv.toLowerCase();
  const charLevel = tibiaFull?.level || profile?.level || 0;
  const charWorld = tibiaFull?.world || profile?.world || "";
  const charGuild = tibiaFull?.guild || profile?.guild || "";
  const charName = resolvedCharName || profile?.name || displayName;

  const tibiaUrl = `https://www.tibia.com/community/?subtopic=characters&name=${encodeURIComponent(charName)}`;

  // -- Header section --
  let headerHtml = `
    <div class="player-header-name">${escapeHtml(displayName)}</div>`;
  if (charName.toLowerCase() !== displayName.toLowerCase()) {
    headerHtml += `<div class="player-header-char">Personagem: <strong>${escapeHtml(charName)}</strong></div>`;
  }
  headerHtml += `<div class="player-header-meta">`;
  if (sv !== "?") headerHtml += `<span class="voc-badge ${svLower}">${sv}</span>`;
  if (charLevel > 0) headerHtml += `<span class="detail-level">Level ${charLevel}</span>`;
  if (charWorld) headerHtml += `<span class="detail-world">${escapeHtml(charWorld)}</span>`;
  if (charGuild) headerHtml += `<span class="detail-guild">${escapeHtml(charGuild)}</span>`;
  headerHtml += `</div>`;
  headerHtml += `<div class="player-header-links">
    <a href="${tibiaUrl}" target="_blank" class="tibia-link">Ver no Tibia.com &rarr;</a>
  </div>`;

  // -- Time stats --
  let timeStatsHtml = "";
  if (profile) {
    const firstSeen = new Date(profile.firstSeen);
    const lastSeen = new Date(profile.lastSeen);
    const firstStr = firstSeen.toLocaleDateString("pt-BR") + " " + firstSeen.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const lastStr = lastSeen.toLocaleDateString("pt-BR") + " " + lastSeen.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

    timeStatsHtml = `
    <div class="detail-section">
      <h3 class="detail-section-title">Atividade</h3>
      <div class="stats-grid stats-grid-3">
        <div class="stat-detail-card">
          <div class="label">Primeira vez visto</div>
          <div class="value" style="color:#818cf8;font-size:0.9em">${firstStr}</div>
        </div>
        <div class="stat-detail-card">
          <div class="label">Ultimo avistamento</div>
          <div class="value" style="color:#34d399;font-size:0.9em">${lastStr}</div>
        </div>
        <div class="stat-detail-card">
          <div class="label">Total de Sessoes</div>
          <div class="value" style="color:#fbbf24">${profile.totalSessions}</div>
        </div>
      </div>
    </div>`;
  }

  // -- Respawn preferences --
  let respawnPrefHtml = "";
  if (profile && Object.keys(profile.respawnUsage).length > 0) {
    const totalUsage = Object.values(profile.respawnUsage).reduce((a, b) => a + b, 0);
    const sortedUsage = Object.entries(profile.respawnUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);

    const prefRows = sortedUsage.map(([code, count]) => {
      const pct = totalUsage > 0 ? Math.round((count / totalUsage) * 100) : 0;
      return `<div class="pref-row">
        <a href="/respawn/${encodeURIComponent(code)}" class="pref-code">${escapeHtml(code)}</a>
        <div class="pref-bar-track"><div class="pref-bar-fill" style="width:${pct}%"></div></div>
        <span class="pref-count">${count}x (${pct}%)</span>
      </div>`;
    }).join("");

    respawnPrefHtml = `
    <div class="detail-section">
      <h3 class="detail-section-title">Respawns Favoritos <span class="count">${Object.keys(profile.respawnUsage).length} respawns</span></h3>
      ${prefRows}
    </div>`;
  }

  // -- Respawn history table from logs --
  let historyHtml = "";
  if (playerHistory.length > 0) {
    const recentHistory = playerHistory.slice(0, 50);
    const histRows = recentHistory.map((h) => {
      const startDate = new Date(h.startedAt);
      const dateStr = startDate.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit" });
      const timeStr = startDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      let duration = "-";
      if (h.endedAt) {
        const durMin = Math.round((new Date(h.endedAt).getTime() - startDate.getTime()) / 60000);
        if (durMin >= 60) {
          duration = Math.floor(durMin / 60) + "h" + (durMin % 60 > 0 ? (durMin % 60) + "min" : "");
        } else {
          duration = durMin + "min";
        }
      } else {
        duration = '<span style="color:#34d399">ativo</span>';
      }
      return `<tr>
        <td class="hist-date">${dateStr} ${timeStr}</td>
        <td><a href="/respawn/${encodeURIComponent(h.code)}" class="respawn-link"><span class="code">${escapeHtml(h.code)}</span></a></td>
        <td class="respawn-name">${escapeHtml(h.respawnName)}</td>
        <td class="hist-duration">${duration}</td>
      </tr>`;
    }).join("");

    historyHtml = `
    <div class="detail-section">
      <h3 class="detail-section-title">Historico de Respawns <span class="count">${playerHistory.length} registros</span></h3>
      <div class="detail-table-scroll">
        <table class="detail-table">
          <thead><tr><th>Data</th><th>Code</th><th>Respawn</th><th>Duracao</th></tr></thead>
          <tbody>${histRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // -- Level history --
  let levelHistHtml = "";
  if (profile && profile.levelHistory.length > 1) {
    const lvlRows = [...profile.levelHistory].reverse().slice(0, 20).map((lh) => {
      return `<tr><td class="hist-date">${escapeHtml(lh.date)}</td><td class="hist-level">${lh.level}</td></tr>`;
    }).join("");
    levelHistHtml = `
    <div class="detail-section">
      <h3 class="detail-section-title">Historico de Level</h3>
      <div class="detail-table-scroll">
        <table class="detail-table">
          <thead><tr><th>Data</th><th>Level</th></tr></thead>
          <tbody>${lvlRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  // -- TibiaData enrichment --
  let tibiaEnrichHtml = "";
  if (tibiaFull) {
    // Account info
    let accountInfoHtml = `<div class="tibia-info-grid">`;
    if (tibiaFull.accountStatus) {
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Conta</span><span class="tibia-info-value">${escapeHtml(tibiaFull.accountStatus)}</span></div>`;
    }
    if (tibiaFull.sex) {
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Sexo</span><span class="tibia-info-value">${escapeHtml(tibiaFull.sex)}</span></div>`;
    }
    if (tibiaFull.achievementPoints !== undefined && tibiaFull.achievementPoints > 0) {
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Achievement Points</span><span class="tibia-info-value" style="color:#fbbf24">${tibiaFull.achievementPoints}</span></div>`;
    }
    if (tibiaFull.residence) {
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Residencia</span><span class="tibia-info-value">${escapeHtml(tibiaFull.residence)}</span></div>`;
    }
    if (tibiaFull.marriedTo) {
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Casado com</span><span class="tibia-info-value" style="color:#f472b6">${escapeHtml(tibiaFull.marriedTo)}</span></div>`;
    }
    if (tibiaFull.lastLogin) {
      const lastLogin = new Date(tibiaFull.lastLogin);
      const lastLoginStr = lastLogin.toLocaleDateString("pt-BR") + " " + lastLogin.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      accountInfoHtml += `<div class="tibia-info-item"><span class="tibia-info-label">Ultimo Login</span><span class="tibia-info-value">${lastLoginStr}</span></div>`;
    }
    accountInfoHtml += `</div>`;

    // Houses
    let housesHtml = "";
    if (tibiaFull.houses && tibiaFull.houses.length > 0) {
      const houseRows = tibiaFull.houses.map((h) =>
        `<div class="tibia-house-item">${escapeHtml(h.name)} <span style="color:#71717a">(${escapeHtml(h.town)})</span></div>`
      ).join("");
      housesHtml = `<div class="tibia-subsection"><h4 class="tibia-subsection-title">Casas</h4>${houseRows}</div>`;
    }

    // Deaths
    let deathsHtml = "";
    if (tibiaFull.deaths && tibiaFull.deaths.length > 0) {
      const deathRows = tibiaFull.deaths.slice(0, 5).map((d) => {
        const deathTime = new Date(d.time);
        const dateStr = deathTime.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " + deathTime.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        const killerNames = d.killers.map((k) =>
          k.player ? `<span style="color:#f87171">${escapeHtml(k.name)}</span>` : escapeHtml(k.name)
        ).join(", ");
        return `<tr>
          <td class="hist-date">${dateStr}</td>
          <td class="hist-level">${d.level}</td>
          <td style="font-size:0.85em">${killerNames || escapeHtml(d.name)}</td>
        </tr>`;
      }).join("");
      deathsHtml = `<div class="tibia-subsection">
        <h4 class="tibia-subsection-title">Mortes Recentes</h4>
        <table class="detail-table">
          <thead><tr><th>Data</th><th>Level</th><th>Causa</th></tr></thead>
          <tbody>${deathRows}</tbody>
        </table>
      </div>`;
    }

    // Other characters
    let otherCharsHtml = "";
    if (tibiaFull.otherCharacters && tibiaFull.otherCharacters.length > 0) {
      const otherRows = tibiaFull.otherCharacters.map((oc) => {
        const statusColor = oc.status === "online" ? "#34d399" : "#71717a";
        return `<tr>
          <td><a href="/player/${encodeURIComponent(oc.name)}" class="player-link"><span class="player-name">${escapeHtml(oc.name)}</span></a></td>
          <td>${escapeHtml(oc.world)}</td>
          <td style="color:${statusColor}">${escapeHtml(oc.status)}</td>
        </tr>`;
      }).join("");
      otherCharsHtml = `<div class="tibia-subsection">
        <h4 class="tibia-subsection-title">Outros Personagens <span class="count">${tibiaFull.otherCharacters.length}</span></h4>
        <div class="detail-table-scroll" style="max-height:250px">
          <table class="detail-table">
            <thead><tr><th>Nome</th><th>Mundo</th><th>Status</th></tr></thead>
            <tbody>${otherRows}</tbody>
          </table>
        </div>
      </div>`;
    }

    // Comment
    let commentHtml = "";
    if (tibiaFull.comment) {
      commentHtml = `<div class="tibia-subsection"><h4 class="tibia-subsection-title">Comentario</h4><div class="tibia-comment">${escapeHtml(tibiaFull.comment)}</div></div>`;
    }

    tibiaEnrichHtml = `
    <div class="detail-section">
      <h3 class="detail-section-title">Dados do TibiaData</h3>
      ${accountInfoHtml}
      ${housesHtml}
      ${commentHtml}
      ${deathsHtml}
      ${otherCharsHtml}
    </div>`;
  }

  // -- Display names / alternate names --
  let altNamesHtml = "";
  if (profile && (profile.displayNames.length > 1 || profile.charNames.length > 1)) {
    let namesContent = "";
    if (profile.displayNames.length > 1) {
      namesContent += `<div class="tibia-subsection"><h4 class="tibia-subsection-title">Nomes no TeamSpeak</h4><div style="color:#a78bfa;font-size:0.9em">${profile.displayNames.map((n) => escapeHtml(n)).join(", ")}</div></div>`;
    }
    if (profile.charNames.length > 1) {
      namesContent += `<div class="tibia-subsection"><h4 class="tibia-subsection-title">Nomes de Personagem</h4><div style="color:#d4d4d8;font-size:0.9em">${profile.charNames.map((n) => escapeHtml(n)).join(", ")}</div></div>`;
    }
    altNamesHtml = `<div class="detail-section">${namesContent}</div>`;
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(displayName)} | Crusaders Player</title>
  <meta http-equiv="refresh" content="30">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Inter', system-ui, sans-serif;
      background: #0b0d17;
      color: #d4d4d8;
      min-height: 100vh;
    }

    .container { max-width: 900px; margin: 0 auto; padding: 20px; }

    .back-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      color: #818cf8;
      text-decoration: none;
      font-size: 0.85em;
      font-weight: 500;
      margin-bottom: 20px;
    }
    .back-link:hover { color: #a5b4fc; text-decoration: underline; }

    .detail-header {
      background: #111322;
      border: 1px solid #1e2030;
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
    }

    .player-header-name {
      font-size: 1.6em;
      font-weight: 700;
      color: #a78bfa;
      margin-bottom: 4px;
    }

    .player-header-char {
      font-size: 0.9em;
      color: #71717a;
      margin-bottom: 8px;
    }
    .player-header-char strong { color: #d4d4d8; }

    .player-header-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .player-header-links { margin-top: 8px; }

    .tibia-link {
      display: inline-block;
      color: #818cf8;
      text-decoration: none;
      font-size: 0.85em;
      font-weight: 500;
      background: #1e2030;
      padding: 6px 14px;
      border-radius: 8px;
      border: 1px solid #2e3150;
    }
    .tibia-link:hover { background: #2e3150; color: #a5b4fc; }

    .voc-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 0.75em;
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .voc-badge.ek { background: #7f1d1d; color: #fca5a5; }
    .voc-badge.rp { background: #14532d; color: #86efac; }
    .voc-badge.ms { background: #1e1b4b; color: #a5b4fc; }
    .voc-badge.ed { background: #422006; color: #fed7aa; }

    .detail-level { color: #d4d4d8; font-family: 'JetBrains Mono', monospace; font-size: 0.9em; font-weight: 600; }
    .detail-guild { color: #71717a; font-size: 0.85em; background: #1e2030; padding: 2px 8px; border-radius: 6px; }
    .detail-world { color: #52525b; font-size: 0.8em; }

    .detail-section {
      background: #111322;
      border: 1px solid #1e2030;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 16px;
    }

    .detail-section-title {
      color: #a1a1aa;
      font-size: 1em;
      font-weight: 600;
      margin-bottom: 14px;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .detail-section-title .count {
      background: #1e2030;
      color: #818cf8;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 0.8em;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 12px;
    }
    .stats-grid-3 {
      grid-template-columns: repeat(3, 1fr);
    }

    .stat-detail-card {
      background: #0f1122;
      border: 1px solid #1a1c2e;
      border-radius: 10px;
      padding: 12px 14px;
      text-align: center;
    }
    .stat-detail-card .label { font-size: 0.7em; color: #71717a; margin-bottom: 4px; }
    .stat-detail-card .value { font-size: 1.4em; font-weight: 700; }

    .detail-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85em;
    }
    .detail-table thead th {
      background: #0f1122;
      color: #a1a1aa;
      font-weight: 600;
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #1e2030;
    }
    .detail-table tbody td {
      padding: 8px 12px;
      border-bottom: 1px solid #1a1c2e;
    }
    .detail-table tbody tr:hover { background: #161830; }
    .detail-table tbody tr:last-child td { border-bottom: none; }

    .detail-table-scroll { max-height: 400px; overflow-y: auto; border-radius: 8px; }

    .detail-empty {
      text-align: center;
      padding: 20px;
      color: #52525b;
      font-size: 0.9em;
    }

    .code {
      font-family: 'JetBrains Mono', 'Consolas', monospace;
      font-weight: 600;
      color: #818cf8;
      font-size: 0.85em;
    }
    .respawn-name { font-weight: 500; color: #f4f4f5; }
    .respawn-link { color: inherit; text-decoration: none; }
    .respawn-link:hover { text-decoration: underline; color: #818cf8; }

    .hist-date { color: #71717a; font-family: 'JetBrains Mono', monospace; font-size: 0.85em; white-space: nowrap; }
    .hist-level { font-family: 'JetBrains Mono', monospace; color: #d4d4d8; }
    .hist-duration { font-family: 'JetBrains Mono', monospace; color: #71717a; }

    .player-link { text-decoration: none; }
    .player-link:hover .player-name { text-decoration: underline; color: #c4b5fd; }
    .player-name { color: #a78bfa; font-weight: 500; }

    /* Respawn preferences bars */
    .pref-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
    .pref-code {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: #818cf8;
      font-size: 0.85em;
      min-width: 50px;
      text-decoration: none;
    }
    .pref-code:hover { color: #a5b4fc; text-decoration: underline; }
    .pref-bar-track { flex: 1; height: 20px; background: #0b0d17; border-radius: 6px; overflow: hidden; }
    .pref-bar-fill { height: 100%; background: #312e81; border-radius: 6px; transition: width 0.5s ease; }
    .pref-count { font-size: 0.75em; color: #71717a; font-family: 'JetBrains Mono', monospace; min-width: 80px; text-align: right; }

    /* TibiaData enrichment */
    .tibia-info-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .tibia-info-item {
      background: #0f1122;
      border: 1px solid #1a1c2e;
      border-radius: 8px;
      padding: 10px 12px;
    }
    .tibia-info-label { display: block; font-size: 0.7em; color: #71717a; margin-bottom: 2px; }
    .tibia-info-value { font-size: 0.9em; color: #d4d4d8; font-weight: 500; }

    .tibia-subsection { margin-top: 14px; }
    .tibia-subsection-title {
      color: #a1a1aa;
      font-size: 0.85em;
      font-weight: 600;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tibia-subsection-title .count {
      background: #1e2030;
      color: #818cf8;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 0.8em;
    }

    .tibia-house-item {
      color: #d4d4d8;
      font-size: 0.85em;
      padding: 4px 0;
    }

    .tibia-comment {
      color: #71717a;
      font-size: 0.85em;
      font-style: italic;
      background: #0f1122;
      padding: 10px 14px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 120px;
      overflow-y: auto;
    }

    @media (max-width: 700px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      .stats-grid-3 { grid-template-columns: 1fr; }
      .tibia-info-grid { grid-template-columns: 1fr; }
      .player-header-name { font-size: 1.2em; }
    }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">&larr; Voltar ao Monitor</a>

    <div class="detail-header">
      ${headerHtml}
    </div>

    ${timeStatsHtml}
    ${respawnPrefHtml}
    ${historyHtml}
    ${levelHistHtml}
    ${tibiaEnrichHtml}
    ${altNamesHtml}

    ${!profile && !tibiaFull ? '<div class="detail-empty">Nenhum dado encontrado para este jogador. Ele pode ainda nao ter sido registrado pelo monitor.</div>' : ''}
  </div>
</body>
</html>`;
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = req.url || "/";

  try {
    // API: /api/respinfo/<code> - query bot for queue details
    const respInfoMatch = url.match(/^\/api\/respinfo\/([a-zA-Z0-9]+)(\?.*)?$/);
    if (respInfoMatch) {
      const code = respInfoMatch[1];
      const queryStr = respInfoMatch[2] || "";
      const forceRefresh = queryStr.includes("force=1");
      const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      };

      // Find remaining minutes from current data
      let remainingMin: number | undefined;
      if (cachedData) {
        const entry = cachedData.entries.find((e) => e.code === code);
        if (entry) remainingMin = entry.remainingMinutes;
      }

      const result = await fetchRespInfoCached(code, remainingMin, forceRefresh);
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify(result || { error: "Sem resposta do bot", code }));
      return;
    }

    // API: /api/stats - log statistics
    if (url === "/api/stats") {
      const stats = getLogStats();
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify(stats, null, 2));
      return;
    }

    // API: /api/clients - all tracked TS clients with Tibia data
    if (url === "/api/clients") {
      const clients = getTrackedClients();
      const clientsArr = Array.from(clients.values()).map((c) => ({
        nickname: c.nickname,
        charName: c.charName,
        clid: c.clid,
        cid: c.cid,
        tibiaData: c.tibiaData,
        lookupFailed: c.lookupFailed,
        lastSeen: c.lastSeen.toISOString(),
      }));
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ total: clientsArr.length, clients: clientsArr }, null, 2));
      return;
    }

    // API: /api/player/<name> - player profile + Tibia lookup
    const playerMatch = url.match(/^\/api\/player\/(.+)$/);
    if (playerMatch) {
      const name = decodeURIComponent(playerMatch[1]);
      const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

      // Get profile from log
      const profile = getPlayerProfile(name);

      // Also do a fresh TibiaData lookup
      const charNames = extractCharNames(name);
      let tibiaData: TibiaCharacter | null = null;
      for (const cn of charNames) {
        tibiaData = await fetchCharacter(cn);
        if (tibiaData) break;
      }

      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ profile, tibiaData, extractedNames: charNames }, null, 2));
      return;
    }

    // API: /api/respawn-history/<code> - usage history for a respawn
    const historyMatch = url.match(/^\/api\/respawn-history\/([a-zA-Z0-9]+)$/);
    if (historyMatch) {
      const code = historyMatch[1];
      const history = getRespawnHistory(code);
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ code, entries: history }, null, 2));
      return;
    }

    // Debug: proxy bridge endpoints
    if (url === "/api/debug/bridge-logs" || url === "/api/debug/bridge-cache" || url === "/api/debug/bridge-status" || url.startsWith("/api/debug/bridge-proxy/")) {
      const corsH = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      try {
        const bridgeUrl = process.env.BRIDGE_URL || "http://localhost:8080";
        const bridgePath = url === "/api/debug/bridge-logs" ? "/api/debug/logs"
          : url === "/api/debug/bridge-status" ? "/api/status"
          : url.startsWith("/api/debug/bridge-proxy/") ? "/api/" + url.substring("/api/debug/bridge-proxy/".length)
          : "/api/debug/cache";
        const raw = await new Promise<string>((resolve, reject) => {
          http.get(`${bridgeUrl}${bridgePath}`, (resp) => {
            let data = "";
            resp.on("data", (chunk: Buffer) => data += chunk);
            resp.on("end", () => resolve(data));
          }).on("error", reject);
        });
        res.writeHead(200, corsH);
        res.end(raw);
      } catch (e: any) {
        res.writeHead(500, corsH);
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // Debug: raw channel list from bridge
    if (url === "/api/debug/channels") {
      const corsH = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
      try {
        const channels = await getChannelList();
        const respCh = await findRespawnListChannel();
        const numCh = await findRespawnNumberChannel();
        let descPreview = "";
        if (respCh) {
          try {
            const d = await getChannelDescription(respCh.cid);
            descPreview = d.substring(0, 200);
          } catch (e: any) { descPreview = "ERROR: " + e.message; }
        }
        res.writeHead(200, corsH);
        res.end(JSON.stringify({ total: channels.length, channels, respawnListChannel: respCh, respawnNumberChannel: numCh, descPreview, bridgeUrl: process.env.BRIDGE_URL, tsMode: process.env.TS_MODE }, null, 2));
      } catch (debugErr: any) {
        res.writeHead(200, corsH);
        res.end(JSON.stringify({ error: debugErr.message, bridgeUrl: process.env.BRIDGE_URL, tsMode: process.env.TS_MODE }));
      }
      return;
    }

    if (url === "/api/respawns") {
      const { respawns, reservations, activeReservations } = await fetchAllData();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(
        JSON.stringify(
          { respawns, activeReservations, totalReservations: reservations?.all.length || 0, lastBotContact: lastBotContact?.toISOString() || null },
          null,
          2
        )
      );
      return;
    }

    // Respawn detail page: /respawn/<code>
    const respawnPageMatch = url.match(/^\/respawn\/([a-zA-Z0-9]+)$/);
    if (respawnPageMatch) {
      const code = respawnPageMatch[1];
      const { respawns, reservations, activeReservations, playerData } = await fetchAllData();
      const catalog = await fetchCatalog();

      // Find the current entry for this respawn
      const entry = respawns.entries.find((e) => e.code === code) || null;
      const respawnName = entry?.name || catalog[code] || code;

      // Get history from logs
      const history = getRespawnHistory(code);

      // Get bot data from cache
      const botData = getCachedRespInfo(code);

      // Get player tibia data
      let playerTibia: TibiaCharacter | null = null;
      let resolvedCharName: string | null = null;
      if (entry) {
        const tracked = getTrackedClient(entry.occupiedBy);
        if (tracked?.tibiaData) {
          playerTibia = tracked.tibiaData;
          resolvedCharName = tracked.charName;
        }
        if (!playerTibia && playerData) {
          const charNames = extractCharNames(entry.occupiedBy);
          for (const cn of charNames) {
            const found = playerData.get(cn);
            if (found) { playerTibia = found; resolvedCharName = cn; break; }
          }
        }
      }

      // Find reservations for this respawn
      const resForRespawn = activeReservations.filter((r) => {
        const match = findReservationsForRespawnByCode(code, respawnName, [r], catalog);
        return match.length > 0;
      });

      const html = renderRespawnDetailHTML(code, entry, respawnName, history, botData, playerTibia, resolvedCharName, resForRespawn);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    // Player detail page: /player/<name>
    const playerPageMatch = url.match(/^\/player\/(.+)$/);
    if (playerPageMatch) {
      const displayName = decodeURIComponent(playerPageMatch[1]);

      // Get profile from our logs
      const profile = getPlayerProfile(displayName);

      // Try to resolve a Tibia character name
      const charNames = extractCharNames(displayName);
      let resolvedCharName: string | null = null;
      let tibiaFull: TibiaCharacterFull | null = null;

      // Try profile charNames first (already resolved), then extracted names
      const namesToTry = [
        ...(profile?.charNames || []),
        ...charNames,
      ];

      for (const cn of namesToTry) {
        tibiaFull = await fetchCharacterFull(cn);
        if (tibiaFull) {
          resolvedCharName = cn;
          break;
        }
      }

      // Get respawn history for this player from logs
      const playerHistory = getPlayerRespawnHistory(displayName);
      // Also search by profile display names and char names
      let allHistory = [...playerHistory];
      if (profile) {
        for (const dn of profile.displayNames) {
          if (dn.toLowerCase() !== displayName.toLowerCase()) {
            const extra = getPlayerRespawnHistory(dn);
            for (const entry of extra) {
              if (!allHistory.some((h) => h.startedAt === entry.startedAt && h.code === entry.code)) {
                allHistory.push(entry);
              }
            }
          }
        }
        for (const cn of profile.charNames) {
          if (cn.toLowerCase() !== displayName.toLowerCase()) {
            const extra = getPlayerRespawnHistory(cn);
            for (const entry of extra) {
              if (!allHistory.some((h) => h.startedAt === entry.startedAt && h.code === entry.code)) {
                allHistory.push(entry);
              }
            }
          }
        }
      }
      allHistory.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

      const html = renderPlayerDetailHTML(displayName, profile, tibiaFull, resolvedCharName, allHistory);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    const { respawns, reservations, activeReservations, playerData } = await fetchAllData();
    const html = renderHTML(respawns, reservations, activeReservations, playerData);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err: any) {
    const errorMsg =
      err.code === "ECONNREFUSED"
        ? "TeamSpeak client nao esta rodando. Abra o TS3 e conecte ao servidor."
        : err.message || String(err);

    res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
      <html><body style="background:#0b0d17;color:#f87171;font-family:sans-serif;padding:40px;">
        <h1>Erro</h1><p>${escapeHtml(errorMsg)}</p>
        <meta http-equiv="refresh" content="10">
      </body></html>
    `);
  }
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch(() => {
      res.writeHead(500);
      res.end("Internal Error");
    });
  });

  const tsInfo = getTSConnectionInfo();
  console.log(`[TS] Mode: ${tsInfo.mode} | Host: ${tsInfo.host}:${tsInfo.port}`);

  // Start background client tracker (polls TS for connected users)
  startClientTracker();

  server.listen(WEB_PORT, () => {
    console.log("Crusaders Respawn Monitor");
    console.log(`TS Mode:   ${tsInfo.mode.toUpperCase()}`);
    console.log(`TS Host:   ${tsInfo.host}:${tsInfo.port}`);
    console.log(`Dashboard: http://localhost:${WEB_PORT}`);
    console.log(`API JSON:  http://localhost:${WEB_PORT}/api/respawns`);
    console.log(`Clients:   http://localhost:${WEB_PORT}/api/clients`);
    console.log("\nAguardando requests...");
  });
}

main();
