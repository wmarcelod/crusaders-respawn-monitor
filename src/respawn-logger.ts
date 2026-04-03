/**
 * Respawn usage logger.
 *
 * Tracks who uses which respawn, with Tibia character info (vocation, level).
 * Data is stored in a JSON file for later analysis.
 *
 * Each snapshot compares with the previous one to detect:
 * - New entries (someone started hunting)
 * - Exits (someone left)
 * - Level/vocation changes (from periodic TibiaData lookups)
 */

import fs from "fs";
import path from "path";
import {
  fetchCharacter,
  fetchCharacters,
  extractCharNames,
  shortVocation,
  TibiaCharacter,
} from "./tibia-api";
import { RespawnEntry } from "./respawn-parser";

const LOG_DIR = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "respawn-history.json");
const PLAYERS_FILE = path.join(LOG_DIR, "players.json");

// --- Interfaces ---

export interface RespawnLogEntry {
  /** When the player was first seen in this respawn */
  startedAt: string;
  /** When the player left (null if still active) */
  endedAt: string | null;
  /** Respawn code */
  code: string;
  /** Respawn name */
  respawnName: string;
  /** Player display name from TS */
  displayName: string;
  /** Extracted Tibia character name(s) */
  charNames: string[];
  /** Vocation at time of logging */
  vocation: string;
  /** Short vocation: EK, RP, MS, ED */
  vocationShort: string;
  /** Level at time of logging */
  level: number;
  /** Total time allocated (minutes) */
  totalMinutes: number;
  /** World */
  world: string;
  /** Guild */
  guild: string;
}

export interface PlayerProfile {
  /** Primary character name */
  name: string;
  /** All known display names from TS */
  displayNames: string[];
  /** All known character names */
  charNames: string[];
  /** Current vocation */
  vocation: string;
  vocationShort: string;
  /** Current level */
  level: number;
  /** Level history: [{date, level}] */
  levelHistory: Array<{ date: string; level: number }>;
  /** World */
  world: string;
  /** Guild */
  guild: string;
  /** Respawns this player has used: {code: count} */
  respawnUsage: Record<string, number>;
  /** Total sessions logged */
  totalSessions: number;
  /** Last seen */
  lastSeen: string;
  /** First seen */
  firstSeen: string;
}

interface LogData {
  entries: RespawnLogEntry[];
  lastSnapshot: Record<string, string>; // code -> displayName (last known state)
}

interface PlayersData {
  players: Record<string, PlayerProfile>; // lowercase char name -> profile
}

// --- File operations ---

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function readLogData(): LogData {
  try {
    const raw = fs.readFileSync(LOG_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { entries: [], lastSnapshot: {} };
  }
}

function writeLogData(data: LogData): void {
  ensureLogDir();
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

function readPlayersData(): PlayersData {
  try {
    const raw = fs.readFileSync(PLAYERS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { players: {} };
  }
}

function writePlayersData(data: PlayersData): void {
  ensureLogDir();
  fs.writeFileSync(PLAYERS_FILE, JSON.stringify(data, null, 2));
}

// --- Core logic ---

/**
 * Process a new snapshot of respawn entries.
 * Compares with previous state to detect new entries and exits.
 * Fetches Tibia character data for new players.
 */
export async function processSnapshot(entries: RespawnEntry[]): Promise<{
  newEntries: number;
  exits: number;
  lookups: number;
}> {
  const logData = readLogData();
  const playersData = readPlayersData();
  const now = new Date().toISOString();

  // Build current state: code -> displayName
  const currentState: Record<string, string> = {};
  for (const e of entries) {
    currentState[e.code] = e.occupiedBy;
  }

  // Detect exits: codes in lastSnapshot but not in currentState (or different player)
  let exits = 0;
  for (const [code, prevPlayer] of Object.entries(logData.lastSnapshot)) {
    if (!currentState[code] || currentState[code] !== prevPlayer) {
      // Player left this respawn - update the log entry
      const openEntry = logData.entries.find(
        (le) => le.code === code && le.displayName === prevPlayer && le.endedAt === null
      );
      if (openEntry) {
        openEntry.endedAt = now;
        exits++;
      }
    }
  }

  // Detect new entries: codes in currentState but not in lastSnapshot (or different player)
  const newPlayers: Array<{ entry: RespawnEntry; charNames: string[] }> = [];
  for (const e of entries) {
    const prevPlayer = logData.lastSnapshot[e.code];
    if (!prevPlayer || prevPlayer !== e.occupiedBy) {
      const charNames = extractCharNames(e.occupiedBy);
      newPlayers.push({ entry: e, charNames });
    }
  }

  // Fetch Tibia data for all new character names
  const allCharNames = newPlayers.flatMap((p) => p.charNames);
  const charData = allCharNames.length > 0
    ? await fetchCharacters(allCharNames)
    : new Map<string, TibiaCharacter>();

  // Create log entries for new players
  let newEntries = 0;
  for (const { entry, charNames } of newPlayers) {
    // Find the best character data (first match)
    let tibiaChar: TibiaCharacter | null = null;
    for (const cn of charNames) {
      tibiaChar = charData.get(cn) || null;
      if (tibiaChar) break;
    }

    const logEntry: RespawnLogEntry = {
      startedAt: now,
      endedAt: null,
      code: entry.code,
      respawnName: entry.name,
      displayName: entry.occupiedBy,
      charNames,
      vocation: tibiaChar?.vocation || "?",
      vocationShort: tibiaChar ? shortVocation(tibiaChar.vocation) : "?",
      level: tibiaChar?.level || 0,
      totalMinutes: entry.totalMinutes,
      world: tibiaChar?.world || "",
      guild: tibiaChar?.guild || "",
    };

    logData.entries.push(logEntry);
    newEntries++;

    // Update player profile
    if (tibiaChar) {
      updatePlayerProfile(playersData, tibiaChar, entry, charNames);
    }
  }

  // Save
  logData.lastSnapshot = currentState;
  writeLogData(logData);
  writePlayersData(playersData);

  return { newEntries, exits, lookups: charData.size };
}

function updatePlayerProfile(
  playersData: PlayersData,
  tibiaChar: TibiaCharacter,
  entry: RespawnEntry,
  charNames: string[]
): void {
  const key = tibiaChar.name.toLowerCase();
  const now = new Date().toISOString();
  const today = now.split("T")[0];

  let profile = playersData.players[key];
  if (!profile) {
    profile = {
      name: tibiaChar.name,
      displayNames: [],
      charNames: [],
      vocation: tibiaChar.vocation,
      vocationShort: shortVocation(tibiaChar.vocation),
      level: tibiaChar.level,
      levelHistory: [],
      world: tibiaChar.world,
      guild: tibiaChar.guild || "",
      respawnUsage: {},
      totalSessions: 0,
      lastSeen: now,
      firstSeen: now,
    };
    playersData.players[key] = profile;
  }

  // Update basic info
  profile.vocation = tibiaChar.vocation;
  profile.vocationShort = shortVocation(tibiaChar.vocation);
  profile.world = tibiaChar.world;
  profile.guild = tibiaChar.guild || "";
  profile.lastSeen = now;

  // Track display names
  if (!profile.displayNames.includes(entry.occupiedBy)) {
    profile.displayNames.push(entry.occupiedBy);
  }
  for (const cn of charNames) {
    if (!profile.charNames.includes(cn)) {
      profile.charNames.push(cn);
    }
  }

  // Track level changes
  if (tibiaChar.level !== profile.level) {
    profile.levelHistory.push({ date: today, level: tibiaChar.level });
    profile.level = tibiaChar.level;
  } else if (
    profile.levelHistory.length === 0 ||
    profile.levelHistory[profile.levelHistory.length - 1].date !== today
  ) {
    profile.levelHistory.push({ date: today, level: tibiaChar.level });
  }

  // Track respawn usage
  profile.respawnUsage[entry.code] = (profile.respawnUsage[entry.code] || 0) + 1;
  profile.totalSessions++;
}

/**
 * Get statistics from the log.
 */
export function getLogStats(): {
  totalEntries: number;
  uniquePlayers: number;
  topRespawns: Array<{ code: string; name: string; count: number }>;
  topPlayers: Array<{ name: string; vocation: string; level: number; sessions: number }>;
  recentActivity: RespawnLogEntry[];
} {
  const logData = readLogData();
  const playersData = readPlayersData();

  // Top respawns by usage
  const respawnCounts: Record<string, { name: string; count: number }> = {};
  for (const e of logData.entries) {
    if (!respawnCounts[e.code]) {
      respawnCounts[e.code] = { name: e.respawnName, count: 0 };
    }
    respawnCounts[e.code].count++;
  }
  const topRespawns = Object.entries(respawnCounts)
    .map(([code, d]) => ({ code, name: d.name, count: d.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  // Top players by sessions
  const topPlayers = Object.values(playersData.players)
    .sort((a, b) => b.totalSessions - a.totalSessions)
    .slice(0, 20)
    .map((p) => ({
      name: p.name,
      vocation: p.vocationShort,
      level: p.level,
      sessions: p.totalSessions,
    }));

  // Recent activity (last 20)
  const recentActivity = logData.entries.slice(-20).reverse();

  return {
    totalEntries: logData.entries.length,
    uniquePlayers: Object.keys(playersData.players).length,
    topRespawns,
    topPlayers,
    recentActivity,
  };
}

/**
 * Get a player's full profile by name.
 */
export function getPlayerProfile(name: string): PlayerProfile | null {
  const playersData = readPlayersData();
  const key = name.toLowerCase().trim();

  // Direct match
  if (playersData.players[key]) return playersData.players[key];

  // Search in charNames and displayNames
  for (const profile of Object.values(playersData.players)) {
    if (
      profile.charNames.some((cn) => cn.toLowerCase() === key) ||
      profile.displayNames.some((dn) => dn.toLowerCase() === key)
    ) {
      return profile;
    }
  }

  return null;
}

/**
 * Get usage history for a specific respawn code.
 */
export function getRespawnHistory(code: string): RespawnLogEntry[] {
  const logData = readLogData();
  return logData.entries
    .filter((e) => e.code === code)
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}

/**
 * Get all respawn log entries for a specific player (by display name or char name).
 * Searches both displayName and charNames fields.
 */
export function getPlayerRespawnHistory(name: string): RespawnLogEntry[] {
  const logData = readLogData();
  const lower = name.toLowerCase().trim();
  return logData.entries
    .filter((e) =>
      e.displayName.toLowerCase() === lower ||
      e.charNames.some((cn) => cn.toLowerCase() === lower)
    )
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
}
