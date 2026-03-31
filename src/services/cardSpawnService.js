const { prisma } = require("../db/prisma");
const { getCardSpawnConfig } = require("../config/cardSpawnConfig");
const { classifyPlayerRarity, pickWeightedBucket } = require("../rules/cardSpawnRules");
const { mintInstanceWithSerial } = require("./cardInstanceMintService");

function logCardPoolError(context, err) {
  const msg = String(err?.message ?? err);
  console.error(`[cardSpawnService] ${context}:`, msg);
  if (/does not exist in the current database|Unknown column|invalid.*invocation/i.test(msg)) {
    console.error(
      "[cardSpawnService] Dica: o schema Prisma (colunas em `instances`: reserved_by_room_id, spawn_source, serial_*, etc.) " +
        "provavelmente ainda nao foi aplicado no Postgres. Rode `npx prisma db push` dentro do container backend (veja PRISMA_DB_PUSH.md).",
    );
  }
}

async function loadPlayersByRarity(cfg) {
  const [players, currentSupplyRows] = await Promise.all([
    prisma.player.findMany({
      select: { id: true, ovr: true, max_supply: true },
    }),
    prisma.instance.groupBy({
      by: ["cardId"],
      _count: { _all: true },
    }),
  ]);

  const supplyByCardId = new Map();
  for (const row of currentSupplyRows) {
    supplyByCardId.set(Number(row.cardId), Number(row?._count?._all ?? 0));
  }

  const grouped = {
    common: [],
    special: [],
    rare: [],
  };

  for (const p of players) {
    const maxSupply = Math.max(0, Number(p.max_supply ?? 0));
    const currentSupply = Math.max(0, Number(supplyByCardId.get(Number(p.id)) ?? 0));
    const remaining = Math.max(0, maxSupply - currentSupply);
    if (remaining <= 0) continue;

    grouped[classifyPlayerRarity(p, cfg)].push({
      id: Number(p.id),
      maxSupply,
      currentSupply,
      remaining,
    });
  }
  return grouped;
}

async function createRarityPool(cfg = getCardSpawnConfig()) {
  return loadPlayersByRarity(cfg);
}

function pickBalancedCardFromBucket(items, rng = Math.random) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const eligible = items.filter((x) => Number(x?.remaining ?? 0) > 0);
  if (eligible.length === 0) return null;

  // Equilibrio: prioriza cartas com menor utilizacao relativa do seu max_supply.
  const utilizationByItem = eligible.map((it) => {
    const util = it.maxSupply > 0 ? it.currentSupply / it.maxSupply : 1;
    return { it, util };
  });
  const minUtil = Math.min(...utilizationByItem.map((x) => x.util));
  const utilWindow = 0.1; // 10pp de janela para evitar concentracao extrema.
  const fairCandidates = utilizationByItem
    .filter((x) => x.util <= minUtil + utilWindow)
    .map((x) => x.it);

  const source = fairCandidates.length > 0 ? fairCandidates : eligible;
  const totalWeight = source.reduce((acc, it) => acc + Math.max(0, Number(it.remaining)), 0);
  if (totalWeight <= 0) return source[0] ?? null;

  let roll = rng() * totalWeight;
  for (const it of source) {
    roll -= Math.max(0, Number(it.remaining));
    if (roll <= 0) return it;
  }
  return source[source.length - 1] ?? null;
}

function consumePickedCardFromPool(grouped, pickedCardId) {
  const buckets = [grouped.common, grouped.special, grouped.rare];
  for (const bucket of buckets) {
    for (const item of bucket) {
      if (Number(item.id) === Number(pickedCardId)) {
        item.currentSupply += 1;
        item.remaining = Math.max(0, item.remaining - 1);
        return;
      }
    }
  }
}

function fallbackPickCardId(grouped) {
  const all = [...grouped.common, ...grouped.special, ...grouped.rare].filter((x) => Number(x.remaining) > 0);
  const picked = pickBalancedCardFromBucket(all);
  return picked ? picked.id : null;
}

async function rollCardId(cfg, cache) {
  const grouped = cache ?? (await loadPlayersByRarity(cfg));
  for (let i = 0; i < 5; i += 1) {
    const bucket = pickWeightedBucket(cfg);
    const picked = pickBalancedCardFromBucket(grouped[bucket]);
    if (picked != null) {
      consumePickedCardFromPool(grouped, picked.id);
      return picked.id;
    }
  }
  const fallback = fallbackPickCardId(grouped);
  if (fallback != null) {
    consumePickedCardFromPool(grouped, fallback);
    return fallback;
  }
  return null;
}

async function refillWorldPool() {
  const cfg = getCardSpawnConfig();
  /** Pool global: sem celula ate uma CellRoom reivindicar. */
  const activeCount = await prisma.instance.count({
    where: {
      spawnSource: "world_pool",
      ownerId: null,
      foundWhen: null,
      reservedByRoomId: null,
      h3RoomCell: null,
    },
  });
  const missing = Math.max(0, Number(cfg.worldMaxSupply) - Number(activeCount));
  if (missing <= 0) {
    return { created: 0, activeCount, target: cfg.worldMaxSupply };
  }

  const createCount = Math.min(missing, Number(cfg.worldSpawnBatchMax));
  const rarityCache = await loadPlayersByRarity(cfg);
  const payload = [];

  for (let i = 0; i < createCount; i += 1) {
    const cardId = await rollCardId(cfg, rarityCache);
    if (!cardId) continue;
    payload.push({
      cardId,
      latitude: 0,
      longitude: 0,
      h3RoomCell: null,
      spawnSource: "world_pool",
    });
  }

  if (payload.length > 0) {
    let createdCount = 0;
    await prisma.$transaction(async (tx) => {
      for (const row of payload) {
        try {
          await mintInstanceWithSerial(tx, {
            cardId: row.cardId,
            ownerId: null,
            latitude: row.latitude,
            longitude: row.longitude,
            h3RoomCell: row.h3RoomCell,
            spawnSource: row.spawnSource,
          });
          createdCount += 1;
        } catch (err) {
          // concorrencia e limite por max_supply sao esperados em alta disputa.
          if (err?.code === "CARD_MAX_SUPPLY_REACHED" || err?.code === "SERIAL_ALLOCATION_CONFLICT") continue;
          throw err;
        }
      }
    });
    return { created: createdCount, activeCount, target: cfg.worldMaxSupply };
  }
  return { created: 0, activeCount, target: cfg.worldMaxSupply };
}

function startCardWorldSpawnLoop() {
  const cfg = getCardSpawnConfig();
  const timer = setInterval(() => {
    refillWorldPool().catch((err) => logCardPoolError("refillWorldPool(tick)", err));
  }, Number(cfg.worldTickIntervalMs));
  return {
    stop() {
      clearInterval(timer);
    },
    tick: refillWorldPool,
  };
}

module.exports = {
  rollCardId,
  createRarityPool,
  refillWorldPool,
  startCardWorldSpawnLoop,
  logCardPoolError,
};
