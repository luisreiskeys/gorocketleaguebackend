function parsePositiveInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNumber(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseNonNegInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function getCardSpawnConfig() {
  return {
    initialPackSize: parsePositiveInt("CARD_INITIAL_PACK_SIZE", 5),
    dailyPackSize: parsePositiveInt("CARD_DAILY_PACK_SIZE", 2),
    dailyCooldownHours: parsePositiveInt("CARD_DAILY_COOLDOWN_HOURS", 24),
    worldMaxSupply: parsePositiveInt("CARD_WORLD_MAX_SUPPLY", 5000),
    worldTickIntervalMs: parsePositiveInt("CARD_WORLD_TICK_INTERVAL_MS", 60000),
    worldSpawnBatchMax: parsePositiveInt("CARD_WORLD_SPAWN_BATCH_MAX", 200),
    weightCommon: parseNumber("CARD_WEIGHT_COMMON", 80),
    weightSpecial: parseNumber("CARD_WEIGHT_SPECIAL", 19),
    weightRare: parseNumber("CARD_WEIGHT_RARE", 1),
    // Classificacao provisoria por OVR.
    commonMaxOvr: parseNumber("CARD_COMMON_MAX_OVR", 79),
    specialMaxOvr: parseNumber("CARD_SPECIAL_MAX_OVR", 89),
    /**
     * Quantas instancias world_pool a CellRoom pode ter reservadas ao mesmo tempo (salas nascem/morrem rapido).
     * Default 2: pool global grande; celulas so "puxam" poucas; ao coletar, repoe ate esse teto.
     */
    roomActiveInstancesMax: parsePositiveInt("CARD_ROOM_ACTIVE_INSTANCES_MAX", 2),
    /** Apos coletar uma carta world_pool na sala, espera este tempo antes de repor do pool (evita spam no mesmo local). Default 5 min. */
    roomCardRefillCooldownMs: parsePositiveInt("CARD_ROOM_REFILL_COOLDOWN_MS", 300000),
    /** Entre duas coletas automaticas (colisao) pelo mesmo usuario na sala — evita varios modais seguidos. */
    cardAutoPickupMinIntervalMs: parsePositiveInt("CARD_AUTO_CARD_MIN_INTERVAL_MS", 3000),
    /** Metros minimos da bandeira (centro da resRoomCell) ao posicionar cartas world_pool no mapa. */
    cardMinFromFlagM: parseNonNegInt("CARD_SPAWN_MIN_FROM_FLAG_M", 25),
  };
}

module.exports = {
  getCardSpawnConfig,
};
