/**
 * Client Tracker - tracks ALL connected TeamSpeak clients and resolves their Tibia data.
 *
 * Periodically fetches all clients from TS (every 30 seconds),
 * looks up each client's Tibia character data with smart caching,
 * and stores the results for use by the web server.
 */

import fs from "fs";
import path from "path";
import { getAllClients } from "./clientquery";
import { tryFetchCharWithFallbacks, TibiaCharacter } from "./tibia-api";

const LOG_DIR = path.join(__dirname, "..", "logs");
const NAME_FAILURES_FILE = path.join(LOG_DIR, "name-extraction-failures.json");

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes - remove disconnected clients
const LOOKUP_BATCH_SIZE = 5;
const LOOKUP_BATCH_DELAY_MS = 1_000; // 1 second between batches

export interface TrackedClient {
  nickname: string;       // TS display name
  charName: string;       // Best matching Tibia character name
  clid: number;
  cid: number;            // Channel they're in
  tibiaData: TibiaCharacter | null;
  lookupFailed: boolean;  // true if we tried and char doesn't exist
  lastSeen: Date;
}

// Cache of all tracked clients
let trackedClients: Map<string, TrackedClient> = new Map();

// Lookup queue: nicknames that need Tibia data resolved
let lookupQueue: string[] = [];
let isProcessingQueue = false;
let pollingTimer: NodeJS.Timeout | null = null;

/**
 * Get a read-only view of all tracked clients.
 */
export function getTrackedClients(): Map<string, TrackedClient> {
  return trackedClients;
}

/**
 * Get a single tracked client by TS nickname (case-insensitive).
 */
export function getTrackedClient(nickname: string): TrackedClient | null {
  // Try exact match first
  const exact = trackedClients.get(nickname);
  if (exact) return exact;

  // Case-insensitive fallback
  const lower = nickname.toLowerCase();
  for (const [key, client] of trackedClients) {
    if (key.toLowerCase() === lower) return client;
  }
  return null;
}

/**
 * Start the background client tracker.
 * Call once from web-server.ts at startup.
 */
export function startClientTracker(apiKey: string): void {
  console.log("[ClientTracker] Starting background tracker (poll every 30s, first poll in 10s)");

  // Delay first poll to let the main server connect first
  setTimeout(() => {
    pollClients(apiKey);
  }, 10_000);

  // Schedule recurring poll
  pollingTimer = setInterval(() => {
    pollClients(apiKey);
  }, POLL_INTERVAL_MS);
}

/**
 * Stop the client tracker (for cleanup).
 */
export function stopClientTracker(): void {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

/**
 * Poll all TS clients and update tracked state.
 */
async function pollClients(apiKey: string): Promise<void> {
  try {
    const clients = await getAllClients(apiKey);
    const now = new Date();
    const seenNicknames = new Set<string>();

    for (const client of clients) {
      seenNicknames.add(client.nickname);

      const existing = trackedClients.get(client.nickname);
      if (existing) {
        // Update connection info (channel may change)
        existing.clid = client.clid;
        existing.cid = client.cid;
        existing.lastSeen = now;
      } else {
        // New client - create entry and queue lookup
        trackedClients.set(client.nickname, {
          nickname: client.nickname,
          charName: client.nickname, // placeholder until lookup
          clid: client.clid,
          cid: client.cid,
          tibiaData: null,
          lookupFailed: false,
          lastSeen: now,
        });

        // Queue for Tibia data lookup
        if (!lookupQueue.includes(client.nickname)) {
          lookupQueue.push(client.nickname);
        }
      }
    }

    // Remove stale clients (disconnected for more than 5 minutes)
    const staleThreshold = now.getTime() - STALE_THRESHOLD_MS;
    for (const [nickname, client] of trackedClients) {
      if (!seenNicknames.has(nickname) && client.lastSeen.getTime() < staleThreshold) {
        trackedClients.delete(nickname);
      }
    }

    // Process any pending lookups
    if (lookupQueue.length > 0 && !isProcessingQueue) {
      processLookupQueue();
    }
  } catch (err: any) {
    // Don't crash on poll errors (TS may be temporarily disconnected)
    console.error("[ClientTracker] Poll error:", err?.message || err);
  }
}

/**
 * Process the lookup queue in batches to avoid overwhelming TibiaData API.
 */
async function processLookupQueue(): Promise<void> {
  if (isProcessingQueue || lookupQueue.length === 0) return;
  isProcessingQueue = true;

  try {
    while (lookupQueue.length > 0) {
      const batch = lookupQueue.splice(0, LOOKUP_BATCH_SIZE);

      const promises = batch.map(async (nickname) => {
        const tracked = trackedClients.get(nickname);
        if (!tracked) return; // client may have disconnected

        try {
          const result = await tryFetchCharWithFallbacks(nickname);
          tracked.charName = result.charName;
          tracked.tibiaData = result.tibiaData;
          tracked.lookupFailed = result.tibiaData === null;

          if (result.tibiaData === null) {
            logNameExtractionFailure(nickname, result.charName);
          }
        } catch (err: any) {
          tracked.lookupFailed = true;
          console.error(`[ClientTracker] Lookup failed for "${nickname}":`, err?.message || err);
        }
      });

      await Promise.all(promises);

      // Delay between batches if more to process
      if (lookupQueue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, LOOKUP_BATCH_DELAY_MS));
      }
    }
  } finally {
    isProcessingQueue = false;
  }
}

/**
 * Log failed name extractions for improving the name extractor later.
 */
function logNameExtractionFailure(displayName: string, attemptedName: string): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    let failures: Array<{ displayName: string; attemptedName: string; timestamp: string }> = [];
    try {
      const raw = fs.readFileSync(NAME_FAILURES_FILE, "utf-8");
      failures = JSON.parse(raw);
    } catch {
      // File doesn't exist or is invalid
    }

    // Don't log duplicates
    const alreadyLogged = failures.some(
      (f) => f.displayName === displayName
    );
    if (alreadyLogged) return;

    failures.push({
      displayName,
      attemptedName,
      timestamp: new Date().toISOString(),
    });

    // Keep last 500 failures
    if (failures.length > 500) {
      failures = failures.slice(-500);
    }

    fs.writeFileSync(NAME_FAILURES_FILE, JSON.stringify(failures, null, 2));
  } catch {
    // Non-critical - don't crash if logging fails
  }
}
