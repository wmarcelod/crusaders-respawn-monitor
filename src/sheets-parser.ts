/**
 * Parser for the Google Sheets reservation data.
 * The sheet has 2 tabs: "Hunts Solo" and "Hunts PT"
 * Each tab contains multiple respawn blocks with day-of-week reservations.
 */

const SHEET_ID = "1_b1znU4lzmEFKEXBo0_plPen2muqHhEgFQApPnHuy-o";
const GID_SOLO = "1898585368";
const GID_PT = "1889453410";

export interface Reservation {
  respawnName: string;
  type: "solo" | "pt";
  player: string;
  days: string[]; // e.g., ["SEGUNDA", "TERCA", "QUARTA"]
  entryTime: string; // e.g., "18:30h"
  exitTime: string;  // e.g., "21:30h"
  entryMinutes: number; // minutes since midnight
  exitMinutes: number;
}

export interface ActiveReservation extends Reservation {
  /** Whether this reservation is active right now */
  isActiveNow: boolean;
  /** Whether this reservation starts within the next 60 min */
  isUpcoming: boolean;
  minutesUntilStart: number;
}

export interface ReservationData {
  solo: Reservation[];
  pt: Reservation[];
  all: Reservation[];
  fetchedAt: Date;
}

const DAY_MAP: Record<number, string> = {
  0: "DOMINGO",
  1: "SEGUNDA",
  2: "TERCA",
  3: "QUARTA",
  4: "QUINTA",
  5: "SEXTA",
  6: "SABADO",
};

const DAY_COLUMNS = [
  "SEGUNDA",
  "TERCA",
  "QUARTA",
  "QUINTA",
  "SEXTA",
  "SABADO",
  "DOMINGO",
];

/**
 * Parse time string like "18:30h", "18h", "9:30h" to minutes since midnight
 */
function parseTimeToMinutes(timeStr: string): number {
  const cleaned = timeStr.replace(/h$/i, "").trim();
  const parts = cleaned.split(":");
  const hours = parseInt(parts[0]) || 0;
  const minutes = parseInt(parts[1]) || 0;
  return hours * 60 + minutes;
}

/**
 * Fetch CSV data from Google Sheets
 */
async function fetchSheetCSV(gid: string): Promise<string> {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gid}`;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch sheet: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

/**
 * Parse a simple CSV line (handles quoted fields)
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Parse CSV data from a sheet tab into reservations
 */
function parseReservationCSV(
  csv: string,
  type: "solo" | "pt"
): Reservation[] {
  const lines = csv.split("\n").map((l) => l.replace(/\r$/, ""));
  const reservations: Reservation[] = [];

  let currentRespawn = "";
  let inDataSection = false;

  for (let i = 0; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    // Skip completely empty lines
    if (fields.every((f) => f === "")) {
      inDataSection = false;
      continue;
    }

    // Detect respawn name: first column has text, rest are empty or mostly empty
    // and it's NOT a header row
    const firstField = fields[0]?.trim() || "";
    const isHeaderRow = firstField === "SEGUNDA";

    if (
      !isHeaderRow &&
      firstField &&
      !inDataSection &&
      fields.slice(1, 7).every((f) => !f.trim())
    ) {
      currentRespawn = firstField;
      continue;
    }

    // Detect header row
    if (isHeaderRow) {
      inDataSection = true;
      continue;
    }

    // Data row: parse player entries
    if (inDataSection && currentRespawn) {
      const entryTime = fields[7]?.trim() || "";
      const exitTime = fields[8]?.trim() || "";

      if (!entryTime || !exitTime) continue;

      // Collect unique players for this time slot and their days
      const playerDays = new Map<string, string[]>();

      for (let d = 0; d < 7; d++) {
        const player = fields[d]?.trim();
        if (player) {
          if (!playerDays.has(player)) {
            playerDays.set(player, []);
          }
          playerDays.get(player)!.push(DAY_COLUMNS[d]);
        }
      }

      for (const [player, days] of playerDays) {
        reservations.push({
          respawnName: currentRespawn,
          type,
          player,
          days,
          entryTime,
          exitTime,
          entryMinutes: parseTimeToMinutes(entryTime),
          exitMinutes: parseTimeToMinutes(exitTime),
        });
      }
    }
  }

  return reservations;
}

/**
 * Fetch and parse all reservations from both sheet tabs
 */
export async function fetchReservations(): Promise<ReservationData> {
  const [soloCSV, ptCSV] = await Promise.all([
    fetchSheetCSV(GID_SOLO),
    fetchSheetCSV(GID_PT),
  ]);

  const solo = parseReservationCSV(soloCSV, "solo");
  const pt = parseReservationCSV(ptCSV, "pt");

  return {
    solo,
    pt,
    all: [...solo, ...pt],
    fetchedAt: new Date(),
  };
}

/**
 * Get active and upcoming reservations for the current time
 */
export function getActiveReservations(
  reservations: Reservation[],
  now?: Date
): ActiveReservation[] {
  const date = now || new Date();
  const today = DAY_MAP[date.getDay()];
  const nowMinutes = date.getHours() * 60 + date.getMinutes();

  return reservations
    .filter((r) => r.days.includes(today))
    .map((r) => {
      const isActiveNow =
        nowMinutes >= r.entryMinutes && nowMinutes < r.exitMinutes;
      const minutesUntilStart = r.entryMinutes - nowMinutes;
      const isUpcoming = !isActiveNow && minutesUntilStart > 0 && minutesUntilStart <= 60;

      return {
        ...r,
        isActiveNow,
        isUpcoming,
        minutesUntilStart,
      };
    })
    .filter((r) => r.isActiveNow || r.isUpcoming)
    .sort((a, b) => {
      // Active first, then by start time
      if (a.isActiveNow && !b.isActiveNow) return -1;
      if (!a.isActiveNow && b.isActiveNow) return 1;
      return a.entryMinutes - b.entryMinutes;
    });
}

/**
 * Match reservations to a specific respawn name (fuzzy match).
 * This is the basic name-only version. For better matching with codes,
 * use findReservationsForRespawnByCode from respawn-matcher.ts
 */
export function findReservationsForRespawn(
  respawnName: string,
  reservations: Reservation[]
): Reservation[] {
  const normalized = respawnName.toLowerCase().trim();

  return reservations.filter((r) => {
    const rName = r.respawnName.toLowerCase().trim();
    return (
      rName === normalized ||
      rName.includes(normalized) ||
      normalized.includes(rName)
    );
  });
}
