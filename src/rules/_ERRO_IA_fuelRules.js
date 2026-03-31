/**
 * Regras de consumo de combustível.
 * * Env: FUEL_PERCENT_PER_KM (default 1 = 1% do fuel por km).
 */

const PERCENT_PER_KM = Number(process.env.FUEL_PERCENT_PER_KM ?? "1");

/**
 * Calcula o novo fuel após percorrer deltaKm nesta atualização.
 *
 * @param {object} user - precisa ter fuel e deltaKm.
 * @returns {number} novo fuel (0–100, com decimais; front formata na UI).
 */
function computeFuel(user) {
  const currentFuel = Number(user?.fuel ?? 0);
  const deltaKm = Number(user?.deltaKm ?? 0);

  if (!Number.isFinite(currentFuel) || currentFuel <= 0) {
    return clampFuel(currentFuel);
  }
  if (!Number.isFinite(deltaKm) || deltaKm <= 0) {
    return clampFuel(currentFuel);
  }

  const percent = (PERCENT_PER_KM / 100) * deltaKm;
  const loss = currentFuel * percent;
  const newFuel = currentFuel - loss;

  return clampFuel(newFuel);
}

function clampFuel(value) {
  const v = Number.isFinite(value) ? value : 0;
  return Math.max(0, Math.min(100, v));
}

module.exports = {
  computeFuel,
};
