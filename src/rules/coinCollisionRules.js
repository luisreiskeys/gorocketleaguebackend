/**
 * Colisão coin ↔ jogador na mesma resolução que a flag (H3_RES_COLLIDE, default 12).
 */
const { latLngToCell } = require("h3-js");

/**
 * @param {number} lat
 * @param {number} lng
 * @param {number} collideRes
 * @returns {string}
 */
function latLngToCollideCell(lat, lng, collideRes) {
  if (![lat, lng].every(Number.isFinite) || collideRes == null) return "";
  try {
    return String(latLngToCell(lat, lng, Number(collideRes)));
  } catch {
    return "";
  }
}

/**
 * @param {string} userCollideCell
 * @param {string} coinCollideCell
 * @returns {boolean}
 */
function cellsCollideForPickup(userCollideCell, coinCollideCell) {
  if (!userCollideCell || !coinCollideCell) return false;
  return String(userCollideCell) === String(coinCollideCell);
}

module.exports = {
  latLngToCollideCell,
  cellsCollideForPickup,
};
