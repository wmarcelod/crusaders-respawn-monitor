/**
 * TibiaData API client.
 * Fetches character info (vocation, level, world, guild) from tibiadata.com.
 *
 * API docs: https://docs.tibiadata.com/swagger.json
 */

export interface TibiaCharacter {
  name: string;
  vocation: string;
  level: number;
  world: string;
  guild?: string;
  lastLogin?: string;
}

export interface TibiaCharacterDeath {
  name: string;
  level: number;
  killers: Array<{ name: string; player: boolean }>;
  time: string;
}

export interface TibiaCharacterOther {
  name: string;
  world: string;
  status: string;
}

export interface TibiaCharacterFull extends TibiaCharacter {
  accountStatus?: string;
  achievementPoints?: number;
  sex?: string;
  residence?: string;
  marriedTo?: string;
  comment?: string;
  houses?: Array<{ name: string; town: string; world: string }>;
  deaths?: TibiaCharacterDeath[];
  otherCharacters?: TibiaCharacterOther[];
}

// Cache: character name (lowercase) -> { data, fetchedAt }
const charCache = new Map<string, { data: TibiaCharacter | null; fetchedAt: number }>();
const CHAR_CACHE_MS = 30 * 60 * 1000; // 30 min cache (level/vocation don't change often)

/**
 * Short vocation names: "Elite Knight" -> "EK", "Royal Paladin" -> "RP", etc.
 */
export function shortVocation(vocation: string): string {
  const map: Record<string, string> = {
    "Elite Knight": "EK",
    "Royal Paladin": "RP",
    "Master Sorcerer": "MS",
    "Elder Druid": "ED",
    "Knight": "EK",
    "Paladin": "RP",
    "Sorcerer": "MS",
    "Druid": "ED",
    "None": "-",
  };
  return map[vocation] || vocation;
}

/**
 * Extract the actual character name from a TS display name.
 *
 * Examples:
 *   "Keplerz - twitch.tv/keplerztv" -> ["Keplerz"]
 *   "Maria maya  /  Veiga"          -> ["Maria maya", "Veiga"]
 *   "[Evil Sheeps]"                  -> ["Evil Sheeps"]
 *   "Don Milo"                      -> ["Don Milo"]
 *   "Player (EK 1500+)"             -> ["Player"]
 *   "Nick | Alt char"               -> ["Nick", "Alt char"]
 *   "Player [TAG]"                  -> ["Player"]
 *   "[TAG] Player"                  -> ["Player"]
 *   "Player (AFK)"                  -> ["Player"]
 *   "Player (LIVE)"                 -> ["Player"]
 */
export function extractCharNames(displayName: string): string[] {
  let name = displayName.trim();

  // Remove emoji characters (unicode emoji ranges)
  name = name.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2702}-\u{27B0}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2300}-\u{23FF}]/gu, "").trim();

  // If the entire name is wrapped in brackets: [Evil Sheeps] -> Evil Sheeps
  if (/^\[.+\]$/.test(name)) {
    name = name.replace(/^\[(.+)\]$/, "$1");
    return [name.trim()].filter((n) => n.length > 0);
  }

  // Remove guild tags at end: "Player [TAG]" -> "Player"
  name = name.replace(/\s*\[[^\]]{2,10}\]\s*$/, "");
  // Remove guild tags at start: "[TAG] Player" -> "Player"
  name = name.replace(/^\s*\[[^\]]{2,10}\]\s+/, "");

  // Remove common suffixes: " - twitch.tv/...", " - youtube", " (EK 1500+)" etc.
  name = name.replace(/\s*[-–]\s*(twitch\.tv|youtube|yt|live|stream|ttv)\S*/i, "");

  // Remove vocation+level suffix: "(EK 1500+)", "(RP)", "(MS 800)" etc.
  name = name.replace(/\s*\((?:EK|RP|MS|ED|Knight|Paladin|Sorcerer|Druid)\s*\d*\+?\)/i, "");

  // Remove status tags: "(AFK)", "(LIVE)", "(DND)", "(BUSY)", "(BRB)", "(AWAY)" etc.
  name = name.replace(/\s*\((?:AFK|LIVE|DND|BUSY|BRB|AWAY|OFFLINE|HUNTING|STREAM|STREAMING)\)/i, "");

  // Split by pipe " | " for multi-char names: "Nick | Alt char"
  if (name.includes(" | ") || name.includes("| ") || name.includes(" |")) {
    return name
      .split(/\s*\|\s*/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }

  // Split by " / " for multi-char names: "Maria maya / Veiga"
  if (name.includes(" / ") || name.includes("  /  ")) {
    return name
      .split(/\s*\/\s*/)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
  }

  // Split by " - " only if NOT already cleaned (twitch etc.)
  // But be careful: "Some Name - Extra" might be a real name split
  // Only split if the part after - looks like a tag, not a name
  const dashParts = name.split(/\s*[-–]\s*/);
  if (dashParts.length === 2) {
    const after = dashParts[1].toLowerCase();
    // If the part after dash contains URLs, tags, or is very short -> it's a tag, use first part
    if (
      after.includes(".tv") ||
      after.includes(".com") ||
      after.includes("twitch") ||
      after.includes("youtube") ||
      after.includes("live") ||
      after.length <= 3
    ) {
      return [dashParts[0].trim()];
    }
  }

  return [name.trim()].filter((n) => n.length > 0);
}

/**
 * Try to fetch a Tibia character from a TS display name, using multiple strategies:
 * 1. Try each name from extractCharNames()
 * 2. If none work, try progressive trimming (remove last word, try again)
 *
 * Returns the best match found or null.
 */
export async function tryFetchCharWithFallbacks(
  displayName: string
): Promise<{ charName: string; tibiaData: TibiaCharacter | null }> {
  const extracted = extractCharNames(displayName);

  // Strategy 1: Try each extracted name
  for (const name of extracted) {
    const data = await fetchCharacter(name);
    if (data) {
      return { charName: name, tibiaData: data };
    }
  }

  // Strategy 2: Progressive trimming - remove last word and try again
  // This handles unknown suffixes like "Player SomeSuffix"
  for (const name of extracted) {
    const words = name.split(/\s+/);
    // Try removing words from the end (but keep at least 1 word)
    for (let len = words.length - 1; len >= 1; len--) {
      const trimmed = words.slice(0, len).join(" ");
      // Skip if we already tried this exact name
      if (extracted.includes(trimmed)) continue;
      const data = await fetchCharacter(trimmed);
      if (data) {
        return { charName: trimmed, tibiaData: data };
      }
    }
  }

  // Nothing found
  return { charName: extracted[0] || displayName.trim(), tibiaData: null };
}

/**
 * Fetch character info from TibiaData API.
 * Returns null if character not found.
 */
export async function fetchCharacter(name: string): Promise<TibiaCharacter | null> {
  const key = name.toLowerCase().trim();

  // Check cache
  const cached = charCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CHAR_CACHE_MS) {
    return cached.data;
  }

  try {
    const encoded = encodeURIComponent(name.trim());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://api.tibiadata.com/v4/character/${encoded}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      charCache.set(key, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const json = await response.json() as any;
    const char = json?.character?.character;

    if (!char || !char.name) {
      charCache.set(key, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const result: TibiaCharacter = {
      name: char.name,
      vocation: char.vocation || "None",
      level: char.level || 0,
      world: char.world || "",
      guild: char.guild?.name,
      lastLogin: char.last_login,
    };

    charCache.set(key, { data: result, fetchedAt: Date.now() });
    return result;
  } catch {
    // On error, return cached if available (even if stale)
    return cached?.data || null;
  }
}

// Cache for full character data
const fullCharCache = new Map<string, { data: TibiaCharacterFull | null; fetchedAt: number }>();
const FULL_CHAR_CACHE_MS = 10 * 60 * 1000; // 10 min cache

/**
 * Fetch full character info from TibiaData API (including deaths, other characters, etc.).
 * Returns null if character not found.
 */
export async function fetchCharacterFull(name: string): Promise<TibiaCharacterFull | null> {
  const key = name.toLowerCase().trim();

  // Check cache
  const cached = fullCharCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FULL_CHAR_CACHE_MS) {
    return cached.data;
  }

  try {
    const encoded = encodeURIComponent(name.trim());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`https://api.tibiadata.com/v4/character/${encoded}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      fullCharCache.set(key, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const json = await response.json() as any;
    const char = json?.character?.character;
    const deaths = json?.character?.deaths;
    const otherChars = json?.character?.other_characters;

    if (!char || !char.name) {
      fullCharCache.set(key, { data: null, fetchedAt: Date.now() });
      return null;
    }

    const result: TibiaCharacterFull = {
      name: char.name,
      vocation: char.vocation || "None",
      level: char.level || 0,
      world: char.world || "",
      guild: char.guild?.name,
      lastLogin: char.last_login,
      accountStatus: char.account_status,
      achievementPoints: char.achievement_points,
      sex: char.sex,
      residence: char.residence,
      marriedTo: char.married_to,
      comment: char.comment,
      houses: Array.isArray(char.houses) ? char.houses.map((h: any) => ({
        name: h.name,
        town: h.town,
        world: h.world,
      })) : [],
      deaths: Array.isArray(deaths) ? deaths.slice(0, 10).map((d: any) => ({
        name: d.reason || "",
        level: d.level || 0,
        killers: Array.isArray(d.killers) ? d.killers.map((k: any) => ({
          name: k.name || "",
          player: k.player || false,
        })) : [],
        time: d.time || "",
      })) : [],
      otherCharacters: Array.isArray(otherChars) ? otherChars.map((oc: any) => ({
        name: oc.name || "",
        world: oc.world || "",
        status: oc.status || "",
      })) : [],
    };

    fullCharCache.set(key, { data: result, fetchedAt: Date.now() });
    return result;
  } catch {
    // On error, return cached if available (even if stale)
    return cached?.data || null;
  }
}

/**
 * Fetch character info for multiple names in parallel (with rate limiting).
 * Returns a map of name -> character info.
 */
export async function fetchCharacters(
  names: string[],
  concurrency: number = 5
): Promise<Map<string, TibiaCharacter>> {
  const results = new Map<string, TibiaCharacter>();
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];

  // Process in batches to avoid overwhelming the API
  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    const promises = batch.map(async (name) => {
      const char = await fetchCharacter(name);
      if (char) results.set(name, char);
    });
    await Promise.all(promises);
  }

  return results;
}
