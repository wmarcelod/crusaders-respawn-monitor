/**
 * SQLite database for persisting respawn data, queue info, and player history.
 *
 * Used as:
 * 1. Cache: faster than re-parsing channel descriptions
 * 2. Fallback: when bridge and plugin are both offline, show last known state
 * 3. History: track who occupied respawns, queue patterns, player stats
 */

import path from "path";
import fs from "fs";

const DB_DIR = process.env.DB_DIR || path.join(__dirname, "..", "data");
const DB_PATH = path.join(DB_DIR, "crusaders.db");

// Ensure data directory exists
fs.mkdirSync(DB_DIR, { recursive: true });

// Try to load better-sqlite3 (native module, may fail in some envs)
let db: any;
let DB_AVAILABLE = false;
try {
  const Database = require("better-sqlite3");
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  DB_AVAILABLE = true;
  console.log("[DB] SQLite database initialized at", DB_PATH);
} catch (err: any) {
  console.warn("[DB] better-sqlite3 not available:", err.message);
  console.warn("[DB] Running without database - no persistent storage");
  db = null;
}

export { DB_AVAILABLE };

// --- Schema ---

if (db) db.exec(`
  CREATE TABLE IF NOT EXISTS respawn_state (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    occupied_by TEXT,
    occupied_by_uid TEXT,
    elapsed_minutes INTEGER,
    total_minutes INTEGER,
    remaining_minutes INTEGER,
    nexts INTEGER DEFAULT 0,
    progress_percent REAL,
    expected_exit TEXT,
    color TEXT,
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS queue_cache (
    code TEXT PRIMARY KEY,
    current_player TEXT,
    current_player_uid TEXT,
    claim_time TEXT,
    claim_minutes INTEGER DEFAULT 0,
    nexts_json TEXT,
    total_queue_minutes INTEGER DEFAULT 0,
    free_at TEXT,
    queried_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS respawn_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    name TEXT,
    occupied_by TEXT NOT NULL,
    occupied_by_uid TEXT,
    started_at TEXT DEFAULT (datetime('now', 'localtime')),
    ended_at TEXT,
    duration_minutes INTEGER,
    nexts_peak INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS player_stats (
    player_name TEXT NOT NULL,
    respawn_code TEXT NOT NULL,
    respawn_name TEXT,
    times_seen INTEGER DEFAULT 1,
    total_minutes INTEGER DEFAULT 0,
    first_seen TEXT DEFAULT (datetime('now', 'localtime')),
    last_seen TEXT DEFAULT (datetime('now', 'localtime')),
    PRIMARY KEY (player_name, respawn_code)
  );

  CREATE TABLE IF NOT EXISTS queue_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL,
    position INTEGER,
    player_name TEXT,
    player_uid TEXT,
    claim_minutes INTEGER,
    queried_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_history_code ON respawn_history(code);
  CREATE INDEX IF NOT EXISTS idx_history_player ON respawn_history(occupied_by);
  CREATE INDEX IF NOT EXISTS idx_history_started ON respawn_history(started_at);
  CREATE INDEX IF NOT EXISTS idx_queue_history_code ON queue_history(code);
  CREATE INDEX IF NOT EXISTS idx_player_stats_player ON player_stats(player_name);

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_clid INTEGER,
    from_name TEXT NOT NULL,
    from_uid TEXT,
    message TEXT NOT NULL,
    target_mode TEXT DEFAULT 'channel',
    channel_name TEXT,
    timestamp TEXT DEFAULT (datetime('now', 'localtime')),
    is_bot INTEGER DEFAULT 0,
    is_command INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_chat_from ON chat_messages(from_name);
  CREATE INDEX IF NOT EXISTS idx_chat_bot ON chat_messages(is_bot);
`);

// --- Prepared statements ---

const stmts = !db ? null : {
  // Respawn state
  upsertState: db.prepare(`
    INSERT INTO respawn_state (code, name, occupied_by, occupied_by_uid, elapsed_minutes, total_minutes, remaining_minutes, nexts, progress_percent, expected_exit, color, updated_at)
    VALUES (@code, @name, @occupiedBy, @occupiedByUid, @elapsedMinutes, @totalMinutes, @remainingMinutes, @nexts, @progressPercent, @expectedExit, @color, datetime('now', 'localtime'))
    ON CONFLICT(code) DO UPDATE SET
      name=@name, occupied_by=@occupiedBy, occupied_by_uid=@occupiedByUid,
      elapsed_minutes=@elapsedMinutes, total_minutes=@totalMinutes, remaining_minutes=@remainingMinutes,
      nexts=@nexts, progress_percent=@progressPercent, expected_exit=@expectedExit, color=@color,
      updated_at=datetime('now', 'localtime')
  `),

  getAllState: db.prepare(`SELECT * FROM respawn_state ORDER BY code`),

  deleteState: db.prepare(`DELETE FROM respawn_state WHERE code = ?`),

  // Queue cache
  upsertQueue: db.prepare(`
    INSERT INTO queue_cache (code, current_player, current_player_uid, claim_time, claim_minutes, nexts_json, total_queue_minutes, free_at, queried_at)
    VALUES (@code, @currentPlayer, @currentPlayerUid, @claimTime, @claimMinutes, @nextsJson, @totalQueueMinutes, @freeAt, datetime('now', 'localtime'))
    ON CONFLICT(code) DO UPDATE SET
      current_player=@currentPlayer, current_player_uid=@currentPlayerUid,
      claim_time=@claimTime, claim_minutes=@claimMinutes, nexts_json=@nextsJson,
      total_queue_minutes=@totalQueueMinutes, free_at=@freeAt,
      queried_at=datetime('now', 'localtime')
  `),

  getQueue: db.prepare(`SELECT * FROM queue_cache WHERE code = ?`),
  getAllQueues: db.prepare(`SELECT * FROM queue_cache`),

  // Respawn history
  getActiveOccupant: db.prepare(`SELECT * FROM respawn_history WHERE code = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`),

  insertHistory: db.prepare(`
    INSERT INTO respawn_history (code, name, occupied_by, occupied_by_uid, started_at)
    VALUES (@code, @name, @occupiedBy, @occupiedByUid, datetime('now', 'localtime'))
  `),

  endHistory: db.prepare(`
    UPDATE respawn_history SET ended_at = datetime('now', 'localtime'), duration_minutes = @durationMinutes, nexts_peak = @nextsPeak
    WHERE id = @id
  `),

  getHistoryForCode: db.prepare(`
    SELECT * FROM respawn_history WHERE code = ? ORDER BY started_at DESC LIMIT 50
  `),

  getHistoryForPlayer: db.prepare(`
    SELECT * FROM respawn_history WHERE occupied_by = ? ORDER BY started_at DESC LIMIT 50
  `),

  getRecentHistory: db.prepare(`
    SELECT * FROM respawn_history WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 100
  `),

  // Player stats
  upsertPlayerStat: db.prepare(`
    INSERT INTO player_stats (player_name, respawn_code, respawn_name, times_seen, total_minutes, first_seen, last_seen)
    VALUES (@playerName, @respawnCode, @respawnName, 1, @minutes, datetime('now', 'localtime'), datetime('now', 'localtime'))
    ON CONFLICT(player_name, respawn_code) DO UPDATE SET
      times_seen = times_seen + 1,
      total_minutes = total_minutes + @minutes,
      last_seen = datetime('now', 'localtime'),
      respawn_name = @respawnName
  `),

  getPlayerStats: db.prepare(`
    SELECT * FROM player_stats WHERE player_name = ? ORDER BY total_minutes DESC
  `),

  getTopPlayers: db.prepare(`
    SELECT player_name, SUM(times_seen) as total_visits, SUM(total_minutes) as total_time
    FROM player_stats GROUP BY player_name ORDER BY total_visits DESC LIMIT 50
  `),

  // Queue history
  insertQueueEntry: db.prepare(`
    INSERT INTO queue_history (code, position, player_name, player_uid, claim_minutes)
    VALUES (@code, @position, @playerName, @playerUid, @claimMinutes)
  `),

  // Chat messages
  insertChatMessage: db.prepare(`
    INSERT INTO chat_messages (from_clid, from_name, from_uid, message, target_mode, channel_name, timestamp, is_bot, is_command)
    VALUES (@fromClid, @fromName, @fromUid, @message, @targetMode, @channelName, @timestamp, @isBot, @isCommand)
  `),

  getChatMessages: db.prepare(`
    SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT ?
  `),

  getChatMessagesByDate: db.prepare(`
    SELECT * FROM chat_messages WHERE timestamp >= @from AND timestamp <= @to ORDER BY timestamp ASC
  `),

  getChatMessagesByPlayer: db.prepare(`
    SELECT * FROM chat_messages WHERE from_name = ? ORDER BY timestamp DESC LIMIT 100
  `),

  getChatStats: db.prepare(`
    SELECT from_name, COUNT(*) as msg_count FROM chat_messages GROUP BY from_name ORDER BY msg_count DESC LIMIT 50
  `),

  getHistoryByDateRange: db.prepare(`
    SELECT * FROM respawn_history WHERE started_at >= @from AND started_at <= @to ORDER BY started_at ASC
  `),

  getChatByDateRange: db.prepare(`
    SELECT * FROM chat_messages WHERE timestamp >= @from AND timestamp <= @to ORDER BY timestamp ASC
  `),
};

// --- Public API ---

export interface RespawnStateRow {
  code: string;
  name: string;
  occupied_by: string;
  occupied_by_uid: string;
  elapsed_minutes: number;
  total_minutes: number;
  remaining_minutes: number;
  nexts: number;
  progress_percent: number;
  expected_exit: string;
  color: string;
  updated_at: string;
}

// Guard: all functions no-op when DB is unavailable
function dbGuard(): boolean {
  if (!db || !stmts) return false;
  return true;
}

/** Save current respawn state (called on each data refresh) */
export function saveRespawnState(entries: Array<{
  code: string;
  name: string;
  occupiedBy: string;
  occupiedByUid: string;
  elapsedMinutes: number;
  totalMinutes: number;
  remainingMinutes: number;
  nexts: number;
  progressPercent: number;
  expectedExit: string;
  color: string;
}>): void {
  if (!dbGuard()) return;
  const tx = db.transaction(() => {
    // Get current codes in DB
    const existing = new Set(
      (stmts!.getAllState.all() as RespawnStateRow[]).map(r => r.code)
    );
    const currentCodes = new Set(entries.map(e => e.code));

    // Upsert active respawns
    for (const e of entries) {
      stmts!.upsertState.run({
        code: e.code,
        name: e.name,
        occupiedBy: e.occupiedBy,
        occupiedByUid: e.occupiedByUid,
        elapsedMinutes: e.elapsedMinutes,
        totalMinutes: e.totalMinutes,
        remainingMinutes: e.remainingMinutes,
        nexts: e.nexts,
        progressPercent: e.progressPercent,
        expectedExit: e.expectedExit,
        color: e.color,
      });
    }

    // Remove respawns no longer occupied
    for (const code of existing) {
      if (!currentCodes.has(code)) {
        stmts!.deleteState.run(code);
      }
    }
  });
  tx();
}

/** Get last known respawn state from DB (fallback when bridge is down) */
export function getLastKnownState(): RespawnStateRow[] {
  if (!dbGuard()) return [];
  return stmts!.getAllState.all() as RespawnStateRow[];
}

/** Save queue/respinfo data from bot */
export function saveQueueInfo(code: string, data: {
  currentPlayer: string;
  currentPlayerUid: string;
  claimTime: string;
  claimMinutes: number;
  nexts: Array<{ position: number; player: string; playerUid: string; claimTime: string; claimMinutes: number }>;
  totalQueueMinutes: number;
  freeAt: string;
}): void {
  if (!dbGuard()) return;
  stmts!.upsertQueue.run({
    code,
    currentPlayer: data.currentPlayer,
    currentPlayerUid: data.currentPlayerUid,
    claimTime: data.claimTime,
    claimMinutes: data.claimMinutes,
    nextsJson: JSON.stringify(data.nexts),
    totalQueueMinutes: data.totalQueueMinutes,
    freeAt: data.freeAt,
  });

  // Also save queue entries to history
  for (const n of data.nexts) {
    stmts!.insertQueueEntry.run({
      code,
      position: n.position,
      playerName: n.player,
      playerUid: n.playerUid,
      claimMinutes: n.claimMinutes,
    });
  }
}

/** Get cached queue data from DB */
export function getCachedQueueFromDB(code: string): any | null {
  if (!dbGuard()) return null;
  const row = stmts!.getQueue.get(code) as any;
  if (!row) return null;
  return {
    code,
    currentPlayer: row.current_player,
    currentPlayerUid: row.current_player_uid,
    claimTime: row.claim_time,
    claimMinutes: row.claim_minutes,
    nexts: JSON.parse(row.nexts_json || "[]"),
    totalQueueMinutes: row.total_queue_minutes,
    freeAt: row.free_at,
    queriedAt: row.queried_at,
  };
}

/** Get all cached queue data */
export function getAllCachedQueues(): Map<string, any> {
  if (!dbGuard()) return new Map();
  const rows = stmts!.getAllQueues.all() as any[];
  const map = new Map();
  for (const row of rows) {
    map.set(row.code, {
      currentPlayer: row.current_player,
      currentPlayerUid: row.current_player_uid,
      claimTime: row.claim_time,
      claimMinutes: row.claim_minutes,
      nexts: JSON.parse(row.nexts_json || "[]"),
      totalQueueMinutes: row.total_queue_minutes,
      freeAt: row.free_at,
      queriedAt: row.queried_at,
    });
  }
  return map;
}

// --- History tracking ---

// Track active occupants per respawn to detect changes
const activeOccupants = new Map<string, { id: number; player: string; nextsPeak: number }>();

/** Update respawn history: detect new occupants and ended occupations */
export function updateHistory(entries: Array<{
  code: string;
  name: string;
  occupiedBy: string;
  occupiedByUid: string;
  elapsedMinutes: number;
  nexts: number;
}>): void {
  if (!dbGuard()) return;
  const currentCodes = new Set(entries.map(e => e.code));

  // Check for ended occupations
  for (const [code, info] of activeOccupants) {
    if (!currentCodes.has(code)) {
      // Respawn freed - end the history entry
      stmts!.endHistory.run({
        id: info.id,
        durationMinutes: 0, // Will be calculated from timestamps
        nextsPeak: info.nextsPeak,
      });
      activeOccupants.delete(code);
    }
  }

  for (const e of entries) {
    const current = activeOccupants.get(e.code);

    if (!current) {
      // New occupation or first time seeing this respawn
      // Check DB for existing active entry
      const dbActive = stmts!.getActiveOccupant.get(e.code) as any;
      if (dbActive && dbActive.occupied_by === e.occupiedBy) {
        // Resume tracking from DB
        activeOccupants.set(e.code, {
          id: dbActive.id,
          player: e.occupiedBy,
          nextsPeak: Math.max(dbActive.nexts_peak || 0, e.nexts),
        });
      } else {
        // New occupant - close old entry if exists
        if (dbActive) {
          stmts!.endHistory.run({ id: dbActive.id, durationMinutes: e.elapsedMinutes, nextsPeak: dbActive.nexts_peak || 0 });
        }
        // Insert new
        const result = stmts!.insertHistory.run({
          code: e.code,
          name: e.name,
          occupiedBy: e.occupiedBy,
          occupiedByUid: e.occupiedByUid,
        });
        activeOccupants.set(e.code, {
          id: Number(result.lastInsertRowid),
          player: e.occupiedBy,
          nextsPeak: e.nexts,
        });
      }
    } else if (current.player !== e.occupiedBy) {
      // Player changed! End old, start new
      stmts!.endHistory.run({ id: current.id, durationMinutes: e.elapsedMinutes, nextsPeak: current.nextsPeak });

      // Update player stats for the old occupant
      stmts!.upsertPlayerStat.run({
        playerName: current.player,
        respawnCode: e.code,
        respawnName: e.name,
        minutes: e.elapsedMinutes,
      });

      const result = stmts!.insertHistory.run({
        code: e.code,
        name: e.name,
        occupiedBy: e.occupiedBy,
        occupiedByUid: e.occupiedByUid,
      });
      activeOccupants.set(e.code, {
        id: Number(result.lastInsertRowid),
        player: e.occupiedBy,
        nextsPeak: e.nexts,
      });
    } else {
      // Same player, update nexts peak
      current.nextsPeak = Math.max(current.nextsPeak, e.nexts);
    }
  }
}

/** Get respawn history */
export function getRespawnHistory(code: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getHistoryForCode.all(code) as any[];
}

/** Get player history */
export function getPlayerHistory(playerName: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getHistoryForPlayer.all(playerName) as any[];
}

/** Get player stats (favorite respawns, time spent, etc.) */
export function getPlayerStatsFromDB(playerName: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getPlayerStats.all(playerName) as any[];
}

/** Get top players by visits */
export function getTopPlayers(): any[] {
  if (!dbGuard()) return [];
  return stmts!.getTopPlayers.all() as any[];
}

/** Get recent respawn changes */
export function getRecentChanges(): any[] {
  if (!dbGuard()) return [];
  return stmts!.getRecentHistory.all() as any[];
}

/** Save a chat message */
export function saveChatMessage(msg: {
  fromClid: number;
  fromName: string;
  fromUid: string;
  message: string;
  targetMode?: string;
  channelName?: string;
  timestamp?: string;
  isBot?: boolean;
  isCommand?: boolean;
}): void {
  if (!dbGuard()) return;
  stmts!.insertChatMessage.run({
    fromClid: msg.fromClid,
    fromName: msg.fromName,
    fromUid: msg.fromUid || "",
    message: msg.message,
    targetMode: msg.targetMode || "channel",
    channelName: msg.channelName || "",
    timestamp: msg.timestamp || new Date().toISOString().replace("T", " ").substring(0, 19),
    isBot: msg.isBot ? 1 : 0,
    isCommand: msg.isCommand ? 1 : 0,
  });
}

/** Save batch of chat messages */
export function saveChatMessages(msgs: Array<{
  fromClid: number;
  fromName: string;
  fromUid: string;
  message: string;
  targetMode?: string;
  channelName?: string;
  timestamp?: string;
  isBot?: boolean;
  isCommand?: boolean;
}>): void {
  if (!dbGuard()) return;
  const tx = db.transaction(() => {
    for (const msg of msgs) {
      // Call stmts directly here since we already checked guard
      stmts!.insertChatMessage.run({
        fromClid: msg.fromClid,
        fromName: msg.fromName,
        fromUid: msg.fromUid || "",
        message: msg.message,
        targetMode: msg.targetMode || "channel",
        channelName: msg.channelName || "",
        timestamp: msg.timestamp || new Date().toISOString().replace("T", " ").substring(0, 19),
        isBot: msg.isBot ? 1 : 0,
        isCommand: msg.isCommand ? 1 : 0,
      });
    }
  });
  tx();
}

/** Get recent chat messages */
export function getChatMessages(limit: number = 100): any[] {
  if (!dbGuard()) return [];
  return stmts!.getChatMessages.all(limit) as any[];
}

/** Get chat messages by date range */
export function getChatMessagesByDate(from: string, to: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getChatMessagesByDate.all({ from, to }) as any[];
}

/** Get respawn history for a date range */
export function getHistoryByDateRange(from: string, to: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getHistoryByDateRange.all({ from, to }) as any[];
}

/** Get chat messages by player */
export function getChatMessagesByPlayer(name: string): any[] {
  if (!dbGuard()) return [];
  return stmts!.getChatMessagesByPlayer.all(name) as any[];
}

/** Get chat statistics (top chatters) */
export function getChatStats(): any[] {
  if (!dbGuard()) return [];
  return stmts!.getChatStats.all() as any[];
}

/** Get DB stats */
export function getDBStats(): { respawns: number; queueEntries: number; historyEntries: number; players: number; chatMessages: number } {
  if (!dbGuard()) return { respawns: 0, queueEntries: 0, historyEntries: 0, players: 0, chatMessages: 0 };
  const respawns = (db.prepare("SELECT COUNT(*) as c FROM respawn_state").get() as any).c;
  const queueEntries = (db.prepare("SELECT COUNT(*) as c FROM queue_cache").get() as any).c;
  const historyEntries = (db.prepare("SELECT COUNT(*) as c FROM respawn_history").get() as any).c;
  const players = (db.prepare("SELECT COUNT(DISTINCT player_name) as c FROM player_stats").get() as any).c;
  const chatMessages = (db.prepare("SELECT COUNT(*) as c FROM chat_messages").get() as any).c;
  return { respawns, queueEntries, historyEntries, players, chatMessages };
}

export default db;
