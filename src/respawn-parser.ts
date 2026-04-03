export interface RespawnEntry {
  code: string;
  name: string;
  elapsedMinutes: number;
  totalMinutes: number;
  remainingMinutes: number;
  elapsedFormatted: string;
  totalFormatted: string;
  remainingFormatted: string;
  progressPercent: number;
  occupiedBy: string;
  occupiedByUid: string;
  nexts: number;
  color: string;
  isAlmostDone: boolean;
  /** true when queue is moving and next person has ~10min to enter */
  isEntryWindow: boolean;
  /** "active" = normal use, "almostDone" = <=15min left, "entryWindow" = time up & queue moving */
  status: "active" | "almostDone" | "entryWindow";
  /** Horario previsto de saida, ex: "16:45" */
  expectedExit: string;
  /** Date object do horario previsto */
  expectedExitDate: Date | null;
}

/** Catalogo completo: code -> nome do respawn */
export interface RespawnCatalog {
  [code: string]: string;
}

export interface RespawnListData {
  timestamp: string;
  totalRespawns: number;
  entries: RespawnEntry[];
  /** Catalogo completo de todos os respawns (do canal Respawn Number) */
  catalog: RespawnCatalog;
  catalogTotal: number;
  /** Respawns livres (no catalogo mas nao ocupados) */
  freeRespawns: Array<{ code: string; name: string }>;
  fetchedAt: Date;
}

/**
 * Parse time string like "01h16m" to total minutes
 */
function parseTimeToMinutes(timeStr: string): number {
  const hMatch = timeStr.match(/(\d+)h/);
  const mMatch = timeStr.match(/(\d+)m/);
  const hours = hMatch ? parseInt(hMatch[1]) : 0;
  const minutes = mMatch ? parseInt(mMatch[1]) : 0;
  return hours * 60 + minutes;
}

/**
 * Format minutes as "01h16m"
 */
function formatMinutes(totalMin: number): string {
  if (totalMin <= 0) return "00h00m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}m`;
}

/**
 * Calcula o horario previsto de saida baseado no timestamp da tabela + tempo restante
 */
function calcExpectedExit(
  tableTimestamp: string,
  remainingMinutes: number
): { formatted: string; date: Date | null } {
  if (remainingMinutes <= 0) {
    return { formatted: "AGORA", date: null };
  }

  // Parse "03/04/2026 16:00:44"
  const tsMatch = tableTimestamp.match(
    /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
  );
  if (!tsMatch) {
    return { formatted: "?", date: null };
  }

  const [, day, month, year, hour, min, sec] = tsMatch;
  const baseDate = new Date(
    parseInt(year),
    parseInt(month) - 1,
    parseInt(day),
    parseInt(hour),
    parseInt(min),
    parseInt(sec)
  );

  const exitDate = new Date(baseDate.getTime() + remainingMinutes * 60 * 1000);

  const hh = String(exitDate.getHours()).padStart(2, "0");
  const mm = String(exitDate.getMinutes()).padStart(2, "0");

  return { formatted: `${hh}:${mm}`, date: exitDate };
}

/**
 * Parse the BBCode from the Respawn Number channel (catalog of all respawns)
 */
export function parseRespawnCatalog(bbcode: string): RespawnCatalog {
  const catalog: RespawnCatalog = {};

  // Match: [tr][td]CODE[/td][td]NAME[/td][/tr]
  const rowRegex =
    /\[tr\]\[td\]([^[]+?)\[\/td\]\[td\]([^[]+?)\[\/td\]\[\/tr\]/g;

  let match;
  while ((match = rowRegex.exec(bbcode)) !== null) {
    const code = match[1].trim();
    const name = match[2].trim();
    // Skip header row
    if (code.toLowerCase() === "code" || code.includes("[b]")) continue;
    catalog[code] = name;
  }

  return catalog;
}

/**
 * Parse the BBCode description from the Respawn List channel
 */
export function parseRespawnList(
  bbcode: string,
  catalog?: RespawnCatalog
): RespawnListData {
  const result: RespawnListData = {
    timestamp: "",
    totalRespawns: 0,
    entries: [],
    catalog: catalog || {},
    catalogTotal: 0,
    freeRespawns: [],
    fetchedAt: new Date(),
  };

  // Extract timestamp: [i]03/04/2026 16:00:44[/i]
  const tsMatch = bbcode.match(
    /\[i\](\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})\[\/i\]/
  );
  if (tsMatch) {
    result.timestamp = tsMatch[1];
  }

  // Match each table row with respawn data
  const rowRegex =
    /\[tr\]\[td\]\[\[B\](.+?)\[\/B\]\]\[\/td\]\[td\]\s*(.+?)\s*\[\/td\]\[td\]\[COLOR=(#[0-9A-Fa-f]+)\]\s*\[B\](\d+h\d+m)\/(\d+h\d+m)\[\/B\]\s*\[\/COLOR\]\[\/td\]\[td\](.*?)\[\/td\]\[td\](.*?)\[\/td\]\[\/tr\]/g;

  const occupiedCodes = new Set<string>();
  let match;
  while ((match = rowRegex.exec(bbcode)) !== null) {
    const code = match[1];
    const name = match[2].trim();
    const color = match[3];
    const elapsedStr = match[4];
    const totalStr = match[5];
    const playerRaw = match[6];
    const nextsRaw = match[7];

    occupiedCodes.add(code);

    // Parse player name from [url=...]PlayerName[/url]
    const playerMatch = playerRaw.match(
      /\[url=client:\/\/\d+\/([^~]+)~\](.+?)\[\/url\]/
    );
    const occupiedBy = playerMatch ? playerMatch[2] : playerRaw.trim();
    const occupiedByUid = playerMatch ? playerMatch[1] : "";

    // Parse nexts: [+1], [+2], etc.
    const nextsMatch = nextsRaw.match(/\[?\+?(\d+)\]?/);
    const nexts = nextsMatch ? parseInt(nextsMatch[1]) : 0;

    const elapsedMinutes = parseTimeToMinutes(elapsedStr);
    const totalMinutes = parseTimeToMinutes(totalStr);
    const remainingMinutes = Math.max(0, totalMinutes - elapsedMinutes);

    const exit = calcExpectedExit(result.timestamp, remainingMinutes);

    // Determine status
    const timeUp = elapsedMinutes >= totalMinutes;
    const isEntryWindow = timeUp && nexts > 0;
    const isAlmostDone = !timeUp && remainingMinutes <= 15 && remainingMinutes > 0;

    let status: "active" | "almostDone" | "entryWindow";
    if (isEntryWindow) {
      status = "entryWindow";
    } else if (isAlmostDone) {
      status = "almostDone";
    } else {
      status = "active";
    }

    result.entries.push({
      code,
      name,
      elapsedMinutes,
      totalMinutes,
      remainingMinutes,
      elapsedFormatted: elapsedStr,
      totalFormatted: totalStr,
      remainingFormatted: formatMinutes(remainingMinutes),
      progressPercent:
        totalMinutes > 0
          ? Math.min(100, Math.round((elapsedMinutes / totalMinutes) * 100))
          : 0,
      occupiedBy,
      occupiedByUid,
      nexts,
      color,
      isAlmostDone,
      isEntryWindow,
      status,
      expectedExit: exit.formatted,
      expectedExitDate: exit.date,
    });
  }

  result.totalRespawns = result.entries.length;

  // Calculate free respawns from catalog
  if (catalog) {
    result.catalogTotal = Object.keys(catalog).length;
    result.freeRespawns = Object.entries(catalog)
      .filter(([code]) => !occupiedCodes.has(code))
      .map(([code, name]) => ({ code, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  return result;
}
