/**
 * Regras puras de posicionamento de coins dentro da célula da sala (H3).
 */
const { cellToChildren, cellToLatLng, getResolution } = require("h3-js");
const { haversineMeters } = require("../utils/geoDistance");

/** h3-js pode retornar [lat, lng] ou { lat, lng } — alinhar a cellOwnership.getCellCenterLatLng. */
function cellToLatLngNormalized(h3Index) {
  try {
    const pos = cellToLatLng(String(h3Index));
    if (Array.isArray(pos)) {
      const lat = Number(pos[0]);
      const lng = Number(pos[1]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }
    if (pos && typeof pos.lat === "number" && typeof pos.lng === "number") {
      return { lat: pos.lat, lng: pos.lng };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * RNG determinístico por seed (reproduzível por sala; não é criptográfico).
 * @param {string} seed
 * @returns {() => number} 0..1
 */
function createSeededRng(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed ?? "");
  for (let i = 0; i < s.length; i += 1) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  }
  return function next() {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return (h >>> 0) / 4294967296;
  };
}

/**
 * Escolhe uma célula H3 para posicionar o coin dentro de `roomCell`.
 * Se `roomCell` já estiver na mesma resolução (ou mais fina) que `preferredChildRes`,
 * `cellToChildren` vem vazio — nesse caso usamos a própria `roomCell` com jitter
 * (caso comum: cliente manda `h3RoomCell` na resolução do usuário em vez do parent da sala).
 *
 * @param {string} roomCell
 * @param {number} preferredChildRes resolução desejada para sorteio (ex.: H3_RES_USER_CELL)
 * @param {() => number} rng
 * @returns {string|null}
 */
function pickRandomSpawnCell(roomCell, preferredChildRes, rng) {
  if (!roomCell || preferredChildRes == null) return null;
  const parent = String(roomCell);
  let parentRes;
  try {
    parentRes = getResolution(parent);
  } catch {
    return null;
  }
  if (parentRes == null || parentRes < 0) return null;

  const want = Number(preferredChildRes);
  if (want > parentRes) {
    const children = cellToChildren(parent, want);
    if (Array.isArray(children) && children.length > 0) {
      const idx = Math.min(children.length - 1, Math.floor(rng() * children.length));
      return children[idx] || null;
    }
  }

  return parent;
}

/**
 * Ponto pseudo-aleatório perto do centro da célula (jitter em graus).
 * @param {string} h3Index
 * @param {() => number} rng
 * @returns {{ lat: number, lng: number }|null}
 */
function randomLatLngInCell(h3Index, rng) {
  if (!h3Index) return null;
  try {
    const c = cellToLatLngNormalized(h3Index);
    if (!c) return null;
    const latJ = (rng() - 0.5) * 0.00045;
    const cosLat = Math.cos((c.lat * Math.PI) / 180);
    const lngScale = Math.max(0.25, Math.abs(cosLat));
    const lngJ = ((rng() - 0.5) * 0.00045) / lngScale;
    return { lat: c.lat + latJ, lng: c.lng + lngJ };
  } catch {
    return null;
  }
}

/**
 * Valor inteiro do coin entre min e max (inclusive).
 * @param {number} minV
 * @param {number} maxV
 * @param {() => number} rng
 */
function rollCoinValue(minV, maxV, rng) {
  const lo = Math.min(minV, maxV);
  const hi = Math.max(minV, maxV);
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Garante que o spawn não fica em cima da flag (anti-farm trivial).
 * @param {number} lat
 * @param {number} lng
 * @param {number} flagLat
 * @param {number} flagLng
 * @param {number} minMeters
 */
function isFarEnoughFromFlag(lat, lng, flagLat, flagLng, minMeters) {
  if (minMeters <= 0) return true;
  if (![flagLat, flagLng].every(Number.isFinite)) return true;
  return haversineMeters(lat, lng, flagLat, flagLng) >= minMeters;
}

/**
 * Tenta gerar posição válida com até `maxAttempts` sorteios.
 * @param {object} params
 * @param {string} params.roomCell
 * @param {number} params.spawnRes
 * @param {number} params.flagLat
 * @param {number} params.flagLng
 * @param {number} params.minFromFlagM
 * @param {() => number} params.rng
 * @param {number} [params.maxAttempts]
 * @returns {{ lat: number, lng: number, h3SpawnCell: string }|null}
 */
function proposeSpawnPlacement(params) {
  const {
    roomCell,
    spawnRes,
    flagLat,
    flagLng,
    minFromFlagM,
    rng,
    maxAttempts = 12,
    isPlacementAllowed = null,
  } = params;

  for (let i = 0; i < maxAttempts; i += 1) {
    const h3SpawnCell = pickRandomSpawnCell(roomCell, spawnRes, rng);
    if (!h3SpawnCell) continue;
    const pos = randomLatLngInCell(h3SpawnCell, rng);
    if (!pos) continue;
    if (typeof isPlacementAllowed === "function" && !isPlacementAllowed(pos, h3SpawnCell)) {
      continue;
    }
    if (isFarEnoughFromFlag(pos.lat, pos.lng, flagLat, flagLng, minFromFlagM)) {
      return { ...pos, h3SpawnCell };
    }
  }
  // Último recurso: ainda dentro da célula da sala, mesmo perto da flag (evita mapa sempre vazio
  // quando a sala é uma única célula fina ou o centro da flag coincide com o sorteio).
  for (let j = 0; j < 8; j += 1) {
    const h3SpawnCell = pickRandomSpawnCell(roomCell, spawnRes, rng);
    if (!h3SpawnCell) continue;
    const pos = randomLatLngInCell(h3SpawnCell, rng);
    if (typeof isPlacementAllowed === "function" && !isPlacementAllowed(pos, h3SpawnCell)) {
      continue;
    }
    if (pos) {
      return { ...pos, h3SpawnCell };
    }
  }
  return null;
}

module.exports = {
  createSeededRng,
  pickRandomSpawnCell,
  randomLatLngInCell,
  rollCoinValue,
  isFarEnoughFromFlag,
  proposeSpawnPlacement,
};
