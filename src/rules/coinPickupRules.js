/**
 * Validação server-side de coleta (distância, existência do asset).
 */
const { haversineMeters } = require("../utils/geoDistance");

/**
 * @param {object} params
 * @param {number} params.userLat
 * @param {number} params.userLng
 * @param {number} params.coinLat
 * @param {number} params.coinLng
 * @param {number} params.pickupRadiusM
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validatePickupDistance(params) {
  const { userLat, userLng, coinLat, coinLng, pickupRadiusM } = params;
  if (!Number.isFinite(pickupRadiusM) || pickupRadiusM <= 0) {
    return { ok: false, reason: "invalid_pickup_config" };
  }
  if (![userLat, userLng, coinLat, coinLng].every(Number.isFinite)) {
    return { ok: false, reason: "invalid_coordinates" };
  }
  const d = haversineMeters(userLat, userLng, coinLat, coinLng);
  if (d > pickupRadiusM) {
    return { ok: false, reason: "too_far" };
  }
  return { ok: true };
}

/**
 * Janela fixa 60s por sessionId (leve, em memória por sala).
 */
function createCollectRateLimiter(maxPerMinute) {
  const max = Math.max(1, Number(maxPerMinute) || 30);
  /** @type {Map<string, { windowStart: number, count: number }>} */
  const bySession = new Map();

  return {
    /**
     * @param {string} sessionId
     * @param {number} nowMs
     * @returns {boolean}
     */
    tryConsume(sessionId, nowMs) {
      if (!sessionId) return false;
      const now = Number(nowMs) || Date.now();
      let row = bySession.get(sessionId);
      if (!row || now - row.windowStart >= 60_000) {
        row = { windowStart: now, count: 0 };
        bySession.set(sessionId, row);
      }
      if (row.count >= max) return false;
      row.count += 1;
      return true;
    },
    clearSession(sessionId) {
      if (sessionId) bySession.delete(sessionId);
    },
  };
}

module.exports = {
  validatePickupDistance,
  createCollectRateLimiter,
};
