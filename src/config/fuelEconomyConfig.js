/**
 * Parâmetros de combustível / compra por moedas (env, sem recompilar).
 * Usado pelo ledger de fuel purchase e replicado em `CellState.economy` para o cliente.
 * Futuro: `getFuelEconomyForRoom(roomCell)` pode retornar valores por zona.
 */

function parsePositiveInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * @param {string} [_roomCell] reserva para preço por zona (h3RoomCell)
 * @returns {{ maxFuel: number, fuelPurchaseCoinsPerPercent: number }}
 */
function getFuelEconomyConfig(_roomCell) {
  return {
    maxFuel: parsePositiveInt("DEFAULT_MAX_FUEL", 100),
    fuelPurchaseCoinsPerPercent: parsePositiveInt("FUEL_PURCHASE_COINS_PER_PERCENT", 1),
  };
}

module.exports = {
  getFuelEconomyConfig,
};
