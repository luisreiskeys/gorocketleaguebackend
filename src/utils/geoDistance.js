/**
 * Distância em metros (esfera WGS84, boa aproximação para pickups em mapa urbano).
 */
const EARTH_RADIUS_M = 6_371_000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) {
    return Number.POSITIVE_INFINITY;
  }
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

module.exports = { haversineMeters, EARTH_RADIUS_M };
