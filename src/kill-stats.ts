/**
 * Kill Statistics & Market Economy module.
 *
 * Combines 3 data sources:
 * 1. TibiaData /v4/killstatistics/{world} - how many creatures killed per day/week
 * 2. TibiaData /v4/creature/{race} - loot tables (item names)
 * 3. TibiaMarket api.tibiamarket.top - item prices, volumes, market data
 *
 * Caches:
 * - Kill stats: 1h (updates slowly on tibia.com)
 * - Creature loot: 24h (only changes on game updates)
 * - Item metadata: 24h (item names/IDs mapping)
 * - Market prices: 6h (market fluctuates)
 */

const WORLD = process.env.TIBIA_WORLD || "Celebra";
const MARKET_API = "https://api.tibiamarket.top";
const TIBIADATA_API = "https://api.tibiadata.com/v4";

// --- Interfaces ---

export interface KillEntry {
  race: string;
  lastDayKilled: number;
  lastDayPlayersKilled: number;
  lastWeekKilled: number;
  lastWeekPlayersKilled: number;
}

export interface CreatureLoot {
  name: string;
  race: string;
  hitpoints: number;
  experience: number;
  lootItems: string[]; // item names
  immunities: string[];
  weaknesses: string[];
  fetchedAt: number;
}

export interface ItemMetadata {
  id: number;
  name: string;
  category: string;
  tier: number;
  wikiName: string;
  npcSellPrice: number; // best NPC sell price
  npcBuyPrice: number;  // best NPC buy price
}

export interface MarketPrice {
  itemId: number;
  buyOffer: number;
  sellOffer: number;
  monthAverageSell: number;
  monthAverageBuy: number;
  monthSold: number;
  monthBought: number;
  dayAverageSell: number;
  dayAverageBuy: number;
  daySold: number;
  dayBought: number;
  activeTraders: number;
  fetchedAt: number;
}

export interface CreatureEconomy {
  race: string;
  name: string;
  killsDay: number;
  killsWeek: number;
  experience: number;
  hitpoints: number;
  lootItems: Array<{
    name: string;
    itemId: number | null;
    marketPrice: number; // sell offer or NPC buy price
    source: "market" | "npc" | "unknown";
  }>;
  estimatedGoldPerKill: number; // rough average
  estimatedDailyGold: number;
  estimatedWeeklyGold: number;
}

// --- Caches ---

const KILL_STATS_CACHE_MS = 60 * 60 * 1000;       // 1 hour
const CREATURE_CACHE_MS = 24 * 60 * 60 * 1000;     // 24 hours
const ITEM_META_CACHE_MS = 24 * 60 * 60 * 1000;    // 24 hours
const MARKET_CACHE_MS = 6 * 60 * 60 * 1000;        // 6 hours

let killStatsCache: { data: KillEntry[]; fetchedAt: number } | null = null;
const creatureCache = new Map<string, CreatureLoot>();
let itemMetaCache: { data: Map<string, ItemMetadata>; byId: Map<number, ItemMetadata>; fetchedAt: number } | null = null;
let marketPriceCache: { data: Map<number, MarketPrice>; fetchedAt: number } | null = null;

// --- Fetch helpers ---

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: { "User-Agent": "CrusadersMonitor/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

// --- Kill Statistics (TibiaData) ---

export async function fetchKillStatistics(): Promise<KillEntry[]> {
  const now = Date.now();
  if (killStatsCache && (now - killStatsCache.fetchedAt) < KILL_STATS_CACHE_MS) {
    return killStatsCache.data;
  }

  console.log(`[KillStats] Fetching kill statistics for ${WORLD}...`);
  const json = await fetchJson(`${TIBIADATA_API}/killstatistics/${WORLD}`);

  const entries: KillEntry[] = (json.killstatistics?.entries || []).map((e: any) => ({
    race: e.race,
    lastDayKilled: e.last_day_killed || 0,
    lastDayPlayersKilled: e.last_day_players_killed || 0,
    lastWeekKilled: e.last_week_killed || 0,
    lastWeekPlayersKilled: e.last_week_players_killed || 0,
  }));

  // Sort by most killed per week
  entries.sort((a, b) => b.lastWeekKilled - a.lastWeekKilled);

  killStatsCache = { data: entries, fetchedAt: now };
  console.log(`[KillStats] Cached ${entries.length} creatures`);
  return entries;
}

// --- Creature Loot (TibiaData) ---

export async function fetchCreatureLoot(race: string): Promise<CreatureLoot | null> {
  const key = race.toLowerCase();
  const cached = creatureCache.get(key);
  const now = Date.now();

  if (cached && (now - cached.fetchedAt) < CREATURE_CACHE_MS) {
    return cached;
  }

  try {
    // TibiaData uses lowercase race slug
    const slug = encodeURIComponent(race.toLowerCase().replace(/\s+/g, "+"));
    const json = await fetchJson(`${TIBIADATA_API}/creature/${slug}`);
    const c = json.creature;

    if (!c || !c.name) return null;

    const loot: CreatureLoot = {
      name: c.name,
      race: c.race || race,
      hitpoints: c.hitpoints || 0,
      experience: c.experience_points || 0,
      lootItems: (c.loot_list || []).map((l: any) => typeof l === "string" ? l : l.name || l),
      immunities: c.immune || [],
      weaknesses: c.weakness || [],
      fetchedAt: now,
    };

    creatureCache.set(key, loot);
    return loot;
  } catch (err: any) {
    console.error(`[KillStats] Failed to fetch creature "${race}":`, err.message);
    return cached || null;
  }
}

// --- Item Metadata (TibiaMarket) ---

export async function fetchItemMetadata(): Promise<Map<string, ItemMetadata>> {
  const now = Date.now();
  if (itemMetaCache && (now - itemMetaCache.fetchedAt) < ITEM_META_CACHE_MS) {
    return itemMetaCache.data;
  }

  console.log("[KillStats] Fetching item metadata from TibiaMarket...");
  const json = await fetchJson(`${MARKET_API}/item_metadata`);
  const items: any[] = Array.isArray(json) ? json : [];

  const byName = new Map<string, ItemMetadata>();
  const byId = new Map<number, ItemMetadata>();

  for (const item of items) {
    // Best NPC sell price (what NPCs charge to sell to player)
    const npcSell = (item.npc_sell || []).reduce((best: number, npc: any) => Math.min(best, npc.price || Infinity), Infinity);
    // Best NPC buy price (what NPCs pay the player)
    const npcBuy = (item.npc_buy || []).reduce((best: number, npc: any) => Math.max(best, npc.price || 0), 0);

    const meta: ItemMetadata = {
      id: item.id,
      name: (item.name || "").toLowerCase(),
      category: item.category || "",
      tier: item.tier || -1,
      wikiName: item.wiki_name || item.name || "",
      npcSellPrice: npcSell === Infinity ? 0 : npcSell,
      npcBuyPrice: npcBuy,
    };

    byName.set(meta.name, meta);
    byId.set(meta.id, meta);
  }

  itemMetaCache = { data: byName, byId, fetchedAt: now };
  console.log(`[KillStats] Cached ${byName.size} item metadata entries`);
  return byName;
}

// --- Market Prices (TibiaMarket) ---

export async function fetchMarketPrices(itemIds?: number[]): Promise<Map<number, MarketPrice>> {
  const now = Date.now();

  // If no specific IDs and we have a fresh cache, return it
  if (!itemIds && marketPriceCache && (now - marketPriceCache.fetchedAt) < MARKET_CACHE_MS) {
    return marketPriceCache.data;
  }

  // Fetch in batches (API limit is 100 per request)
  const allPrices = new Map<number, MarketPrice>();
  const batchSize = 100;

  if (itemIds && itemIds.length > 0) {
    for (let i = 0; i < itemIds.length; i += batchSize) {
      const batch = itemIds.slice(i, i + batchSize);
      const idsParam = batch.join(",");
      try {
        const json = await fetchJson(`${MARKET_API}/market_values?server=${WORLD}&item_ids=${idsParam}&limit=${batchSize}`);
        const items: any[] = Array.isArray(json) ? json : [];
        for (const item of items) {
          allPrices.set(item.id, {
            itemId: item.id,
            buyOffer: item.buy_offer || 0,
            sellOffer: item.sell_offer || 0,
            monthAverageSell: item.month_average_sell || 0,
            monthAverageBuy: item.month_average_buy || 0,
            monthSold: item.month_sold || 0,
            monthBought: item.month_bought || 0,
            dayAverageSell: item.day_average_sell || 0,
            dayAverageBuy: item.day_average_buy || 0,
            daySold: item.day_sold || 0,
            dayBought: item.day_bought || 0,
            activeTraders: item.active_traders || 0,
            fetchedAt: now,
          });
        }
      } catch (err: any) {
        console.error(`[KillStats] Market fetch batch error:`, err.message);
      }

      // Rate limit between batches
      if (i + batchSize < itemIds.length) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  } else {
    // Fetch top items by volume
    try {
      const json = await fetchJson(`${MARKET_API}/market_values?server=${WORLD}&limit=100`);
      const items: any[] = Array.isArray(json) ? json : [];
      for (const item of items) {
        allPrices.set(item.id, {
          itemId: item.id,
          buyOffer: item.buy_offer || 0,
          sellOffer: item.sell_offer || 0,
          monthAverageSell: item.month_average_sell || 0,
          monthAverageBuy: item.month_average_buy || 0,
          monthSold: item.month_sold || 0,
          monthBought: item.month_bought || 0,
          dayAverageSell: item.day_average_sell || 0,
          dayAverageBuy: item.day_average_buy || 0,
          daySold: item.day_sold || 0,
          dayBought: item.day_bought || 0,
          activeTraders: item.active_traders || 0,
          fetchedAt: now,
        });
      }
    } catch (err: any) {
      console.error("[KillStats] Market fetch error:", err.message);
    }
  }

  if (!itemIds) {
    marketPriceCache = { data: allPrices, fetchedAt: now };
  }
  return allPrices;
}

// --- Combined: Creature Economy Analysis ---

/**
 * Get economy data for a specific creature.
 * Combines kill stats, loot table, and market prices.
 */
export async function getCreatureEconomy(race: string): Promise<CreatureEconomy | null> {
  const [killStats, loot, itemMeta] = await Promise.all([
    fetchKillStatistics(),
    fetchCreatureLoot(race),
    fetchItemMetadata(),
  ]);

  if (!loot) return null;

  const kill = killStats.find(k => k.race.toLowerCase() === race.toLowerCase());
  const killsDay = kill?.lastDayKilled || 0;
  const killsWeek = kill?.lastWeekKilled || 0;

  // Resolve item IDs for loot
  const lootItemIds: number[] = [];
  const lootItemMap: Array<{ name: string; meta: ItemMetadata | null }> = [];

  for (const itemName of loot.lootItems) {
    const meta = itemMeta.get(itemName.toLowerCase());
    lootItemMap.push({ name: itemName, meta: meta || null });
    if (meta) lootItemIds.push(meta.id);
  }

  // Fetch market prices for these items
  const prices = lootItemIds.length > 0 ? await fetchMarketPrices(lootItemIds) : new Map();

  // Build loot items with prices
  const lootItems = lootItemMap.map(({ name, meta }) => {
    let marketPrice = 0;
    let source: "market" | "npc" | "unknown" = "unknown";

    if (meta) {
      const price = prices.get(meta.id);
      if (price && price.sellOffer > 0) {
        marketPrice = price.sellOffer;
        source = "market";
      } else if (meta.npcBuyPrice > 0) {
        marketPrice = meta.npcBuyPrice;
        source = "npc";
      }
    }

    return {
      name,
      itemId: meta?.id || null,
      marketPrice,
      source,
    };
  });

  // Rough estimate: average gold per kill (assumes ~50% drop chance average)
  // This is very rough since TibiaData doesn't provide drop rates
  const totalLootValue = lootItems.reduce((sum, item) => sum + item.marketPrice, 0);
  const estimatedGoldPerKill = Math.round(totalLootValue * 0.15); // ~15% of total possible loot

  return {
    race: loot.race,
    name: loot.name,
    killsDay,
    killsWeek,
    experience: loot.experience,
    hitpoints: loot.hitpoints,
    lootItems,
    estimatedGoldPerKill,
    estimatedDailyGold: estimatedGoldPerKill * killsDay,
    estimatedWeeklyGold: estimatedGoldPerKill * killsWeek,
  };
}

// --- Top Creatures by Kill Count ---

export interface TopCreature {
  race: string;
  killsDay: number;
  killsWeek: number;
  playersKilledDay: number;
  playersKilledWeek: number;
}

/**
 * Get top killed creatures.
 */
export async function getTopKilled(limit: number = 50): Promise<TopCreature[]> {
  const stats = await fetchKillStatistics();
  return stats.slice(0, limit).map(k => ({
    race: k.race,
    killsDay: k.lastDayKilled,
    killsWeek: k.lastWeekKilled,
    playersKilledDay: k.lastDayPlayersKilled,
    playersKilledWeek: k.lastWeekPlayersKilled,
  }));
}

// --- Market Overview ---

export interface MarketItem {
  id: number;
  name: string;
  category: string;
  buyOffer: number;
  sellOffer: number;
  spread: number; // sell - buy
  spreadPercent: number;
  monthVolume: number;
  dayVolume: number;
  activeTraders: number;
}

/**
 * Get market overview: top traded items with prices.
 */
export async function getMarketOverview(limit: number = 50): Promise<MarketItem[]> {
  const [meta, prices] = await Promise.all([
    fetchItemMetadata(),
    fetchMarketPrices(),
  ]);

  const items: MarketItem[] = [];
  for (const [id, price] of prices) {
    const itemMeta = itemMetaCache?.byId.get(id);
    if (!itemMeta) continue;

    const spread = price.sellOffer - price.buyOffer;
    items.push({
      id,
      name: itemMeta.wikiName || itemMeta.name,
      category: itemMeta.category,
      buyOffer: price.buyOffer,
      sellOffer: price.sellOffer,
      spread,
      spreadPercent: price.buyOffer > 0 ? Math.round((spread / price.buyOffer) * 100) : 0,
      monthVolume: price.monthSold + price.monthBought,
      dayVolume: price.daySold + price.dayBought,
      activeTraders: price.activeTraders,
    });
  }

  // Sort by month volume
  items.sort((a, b) => b.monthVolume - a.monthVolume);
  return items.slice(0, limit);
}

/**
 * Get item price history from TibiaMarket.
 */
export async function getItemHistory(itemId: number, days: number = 30): Promise<any[]> {
  try {
    const json = await fetchJson(`${MARKET_API}/item_history?server=${WORLD}&item_id=${itemId}&start_days_ago=${days}`);
    return Array.isArray(json) ? json : [];
  } catch (err: any) {
    console.error(`[KillStats] Item history error for ${itemId}:`, err.message);
    return [];
  }
}

/**
 * Search items by name in metadata cache.
 */
export async function searchItems(query: string, limit: number = 20): Promise<ItemMetadata[]> {
  const meta = await fetchItemMetadata();
  const q = query.toLowerCase();
  const results: ItemMetadata[] = [];

  for (const [name, item] of meta) {
    if (name.includes(q) || item.wikiName.toLowerCase().includes(q)) {
      results.push(item);
      if (results.length >= limit) break;
    }
  }

  return results;
}
