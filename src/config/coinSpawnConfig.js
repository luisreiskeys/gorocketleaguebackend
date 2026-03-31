/**
 * Configuração de spawn de coins na CellRoom (env, sem recompilar).
 * Cada sala é independente; valores aqui são globais por processo.
 */
function parsePositiveInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseBool(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const v = String(raw).toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return fallback;
}

function parseFloatEnv(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clampRes(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < 0) return 0;
  if (i > 15) return 15;
  return i;
}

/**
 * Snapshot atual da config (chame de novo se alterar env em runtime).
 */
function getCoinSpawnConfig() {
  const minActiveCoins = parsePositiveInt("COIN_SPAWN_MIN_ACTIVE", 7);
  const maxActiveCoins = parsePositiveInt("COIN_SPAWN_MAX_ACTIVE", 15);
  const spawnIntervalMs = parsePositiveInt("COIN_SPAWN_INTERVAL_MS", 10_000);
  const minValue = parsePositiveInt("COIN_SPAWN_MIN_VALUE", 1);
  let maxValue = parsePositiveInt("COIN_SPAWN_MAX_VALUE", 5);
  if (maxValue < minValue) maxValue = minValue;

  /** Legado: coleta usa só H3_RES_COLLIDE (igual à flag); este valor não entra mais na validação. */
  const pickupRadiusM = parseFloatEnv("COIN_PICKUP_RADIUS_M", 40);
  const minFromFlagM = parseNonNegInt("COIN_SPAWN_MIN_FROM_FLAG_M", 25);
  const minSpacingRes = clampRes(parseNonNegInt("COIN_SPAWN_MIN_SPACING_RES", 10), 10);

  const collectPerMinute = parsePositiveInt("COIN_COLLECT_MAX_PER_MINUTE", 30);
  const safeMinActiveCoins = Math.min(minActiveCoins, maxActiveCoins);

  return {
    enabled: parseBool("COIN_SPAWN_ENABLED", true),
    minActiveCoins: safeMinActiveCoins,
    maxActiveCoins,
    spawnIntervalMs,
    minValue,
    maxValue,
    pickupRadiusM,
    minFromFlagM,
    minSpacingRes,
    collectPerMinute,
  };
}

module.exports = {
  getCoinSpawnConfig,
};
