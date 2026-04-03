/**
 * Smart respawn name matcher.
 *
 * The Google Sheets reservation data uses informal/Portuguese names,
 * while the TS catalog uses the "official" names. This module bridges the gap.
 *
 * Strategy (in priority order):
 * 1. Direct mapping from respawn-aliases.json (reservationName -> code)
 * 2. Extract code from text (e.g., "GT FUNDO - 37C" -> code "37c")
 * 3. Exact match (case-insensitive)
 * 4. Alias/synonym dictionary (loaded from respawn-aliases.json)
 * 5. Substring containment (both directions)
 * 6. Word overlap scoring
 */

import fs from "fs";
import path from "path";
import { RespawnCatalog } from "./respawn-parser";

// --- Alias loading from JSON with caching ---

interface AliasConfig {
  aliases: Record<string, string>;       // keyword -> catalog equivalent
  directMappings: Record<string, string>; // reservation name -> catalog code
}

let cachedAliasConfig: AliasConfig | null = null;
let aliasLoadedAt = 0;
const ALIAS_CACHE_MS = 5 * 60 * 1000; // 5 minutes

const ALIAS_FILE = path.join(__dirname, "..", "respawn-aliases.json");

function loadAliasConfig(): AliasConfig {
  const now = Date.now();
  if (cachedAliasConfig && now - aliasLoadedAt < ALIAS_CACHE_MS) {
    return cachedAliasConfig;
  }

  try {
    const raw = fs.readFileSync(ALIAS_FILE, "utf-8");
    const json = JSON.parse(raw);
    cachedAliasConfig = {
      aliases: json.aliases || {},
      directMappings: json.directMappings || {},
    };
    aliasLoadedAt = now;
    return cachedAliasConfig;
  } catch {
    // If file doesn't exist or is invalid, return empty config
    cachedAliasConfig = { aliases: {}, directMappings: {} };
    aliasLoadedAt = now;
    return cachedAliasConfig;
  }
}

/**
 * Directional keywords that should match between names
 */
const DIRECTION_MAP: Record<string, string[]> = {
  "norte": ["norte", "north", "n"],
  "sul": ["sul", "south", "s"],
  "esquerda": ["esquerda", "esq", "left", "e"],
  "direita": ["direita", "dir", "right", "d"],
  "norte-direita": ["norte-direita", "norte dir", "nd"],
  "norte-esquerda": ["norte-esquerda", "norte esq", "ne"],
  "sul-direita": ["sul-direita", "sul dir", "sd"],
  "sul-esquerda": ["sul-esquerda", "sul esq", "se"],
};

export interface MatchResult {
  code: string;
  catalogName: string;
  confidence: number; // 0-100
  method: string;
}

/**
 * Try to extract a respawn code directly from the text.
 * e.g., "GT FUNDO - 37C" -> "37c"
 */
function extractCode(text: string, catalog: RespawnCatalog): string | null {
  // Look for patterns like "- 37C", "37c", "(201a)" etc.
  // Require at least 2 digits to avoid matching "-1", "-2" suffixes
  const codePatterns = [
    /[-–]\s*(\d{2,4}[a-zA-Z]?)\s*$/,   // "GT FUNDO - 37C"
    /\((\d{2,4}[a-zA-Z]?)\)/,           // "(37c)"
    /\[(\d{2,4}[a-zA-Z]?)\]/,           // "[37c]"
    /^(\d{2,4}[a-zA-Z]?)\s*[-–]/,       // "37c - Gold Token"
    /\b(\d{2,4}[a-zA-Z])\b/,            // any code-like pattern with letter suffix
  ];

  for (const pattern of codePatterns) {
    const match = text.match(pattern);
    if (match) {
      const code = match[1].toLowerCase();
      if (catalog[code]) return code;
    }
  }

  return null;
}

/**
 * Normalize a string for comparison
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove accents
    .replace(/[^\w\s+\-\/]/g, " ")  // keep +, -, /, alphanumeric
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Get significant words from a name (skip very short/common ones)
 */
function getWords(str: string): string[] {
  return normalize(str)
    .split(/[\s\-+]+/)
    .filter(w => w.length > 1 && !["de", "do", "da", "e", "o", "a"].includes(w));
}

/**
 * Calculate word overlap score between two names
 */
function wordOverlapScore(name1: string, name2: string): number {
  const words1 = getWords(name1);
  const words2 = getWords(name2);

  if (words1.length === 0 || words2.length === 0) return 0;

  let matches = 0;
  for (const w1 of words1) {
    for (const w2 of words2) {
      if (w1 === w2 || w1.includes(w2) || w2.includes(w1)) {
        matches++;
        break;
      }
    }
  }

  // Score based on proportion of words matched in both names
  const score1 = matches / words1.length;
  const score2 = matches / words2.length;
  return Math.round(((score1 + score2) / 2) * 100);
}

/**
 * Apply alias dictionary: translate reservation name to catalog-style name.
 * Loads aliases from respawn-aliases.json (cached, reloaded every 5 min).
 */
function applyAliases(reservationName: string): string[] {
  const lower = normalize(reservationName);
  const results: string[] = [];
  const config = loadAliasConfig();

  for (const [pattern, replacement] of Object.entries(config.aliases)) {
    if (lower.includes(pattern)) {
      results.push(lower.replace(pattern, replacement));
    }
  }

  return results;
}

/**
 * Check direct mappings from respawn-aliases.json.
 * Maps a reservation name directly to a catalog code.
 */
function checkDirectMapping(reservationName: string, catalog: RespawnCatalog): MatchResult | null {
  const config = loadAliasConfig();
  const norm = normalize(reservationName);

  for (const [name, code] of Object.entries(config.directMappings)) {
    if (normalize(name) === norm) {
      const lowerCode = code.toLowerCase();
      if (catalog[lowerCode] || catalog[code]) {
        const actualCode = catalog[lowerCode] ? lowerCode : code;
        return {
          code: actualCode,
          catalogName: catalog[actualCode] || code,
          confidence: 100,
          method: "direct-mapping",
        };
      }
    }
  }

  return null;
}

/**
 * Match a reservation name against the catalog.
 * Returns the best match with confidence score.
 */
export function matchRespawnName(
  reservationName: string,
  catalog: RespawnCatalog
): MatchResult | null {
  const catalogEntries = Object.entries(catalog);
  if (catalogEntries.length === 0) return null;

  const resNorm = normalize(reservationName);

  // 0. Direct mapping from respawn-aliases.json
  const directMap = checkDirectMapping(reservationName, catalog);
  if (directMap) return directMap;

  // 1. Extract code directly from the text
  const directCode = extractCode(reservationName, catalog);
  if (directCode) {
    return {
      code: directCode,
      catalogName: catalog[directCode],
      confidence: 100,
      method: "code-in-text",
    };
  }

  // 2. Exact match (normalized)
  for (const [code, name] of catalogEntries) {
    if (normalize(name) === resNorm) {
      return { code, catalogName: name, confidence: 100, method: "exact" };
    }
  }

  // 3. Alias-based match
  const aliasedNames = applyAliases(reservationName);
  for (const aliased of aliasedNames) {
    // Try exact match with aliased name
    for (const [code, name] of catalogEntries) {
      if (normalize(name) === aliased) {
        return { code, catalogName: name, confidence: 95, method: "alias-exact" };
      }
    }
    // Try substring match with aliased name
    for (const [code, name] of catalogEntries) {
      const catNorm = normalize(name);
      if (catNorm.includes(aliased) || aliased.includes(catNorm)) {
        return { code, catalogName: name, confidence: 85, method: "alias-substring" };
      }
    }
    // Try word overlap with aliased name
    let bestScore = 0;
    let bestMatch: [string, string] | null = null;
    for (const [code, name] of catalogEntries) {
      const score = wordOverlapScore(aliased, name);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = [code, name];
      }
    }
    if (bestMatch && bestScore >= 60) {
      return {
        code: bestMatch[0],
        catalogName: bestMatch[1],
        confidence: Math.min(80, bestScore),
        method: "alias-words",
      };
    }
  }

  // 4. Substring containment (both directions)
  for (const [code, name] of catalogEntries) {
    const catNorm = normalize(name);
    if (catNorm.includes(resNorm) || resNorm.includes(catNorm)) {
      return { code, catalogName: name, confidence: 80, method: "substring" };
    }
  }

  // 5. Word overlap scoring
  let bestScore = 0;
  let bestMatch: [string, string] | null = null;
  for (const [code, name] of catalogEntries) {
    const score = wordOverlapScore(reservationName, name);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = [code, name];
    }
  }

  if (bestMatch && bestScore >= 50) {
    return {
      code: bestMatch[0],
      catalogName: bestMatch[1],
      confidence: bestScore,
      method: "word-overlap",
    };
  }

  return null;
}

/**
 * Build a complete mapping: reservation name -> { code, catalogName }
 * Returns both matched and unmatched entries for debugging.
 */
export function buildReservationCodeMap(
  reservationNames: string[],
  catalog: RespawnCatalog
): {
  mapped: Map<string, MatchResult>;
  unmapped: string[];
} {
  const mapped = new Map<string, MatchResult>();
  const unmapped: string[] = [];

  const unique = [...new Set(reservationNames)];

  for (const name of unique) {
    const match = matchRespawnName(name, catalog);
    if (match) {
      mapped.set(name, match);
    } else {
      unmapped.push(name);
    }
  }

  return { mapped, unmapped };
}

/**
 * Enhanced findReservationsForRespawn that uses the catalog for code-based matching.
 * Falls back to name-based fuzzy matching if no catalog is available.
 */
export function findReservationsForRespawnByCode(
  respawnCode: string,
  respawnName: string,
  reservations: Array<{ respawnName: string; [key: string]: any }>,
  catalog: RespawnCatalog
): typeof reservations {
  return reservations.filter((r) => {
    // Try to match reservation name to a code via catalog
    const match = matchRespawnName(r.respawnName, catalog);
    if (match && match.code === respawnCode) {
      return true;
    }

    // Fallback: name-based fuzzy match
    const rNorm = normalize(r.respawnName);
    const nameNorm = normalize(respawnName);
    return (
      rNorm === nameNorm ||
      rNorm.includes(nameNorm) ||
      nameNorm.includes(rNorm)
    );
  });
}
