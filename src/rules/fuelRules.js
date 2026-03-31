const PERCENT_PER_KM = Number(process.env.FUEL_PERCENT_PER_KM ?? "1");

function computeFuel(user, maxFuel = 100) {
  const currentFuel = Number(user?.fuel ?? 0);
  const deltaKm = Number(user?.deltaKm ?? 0);

  if (!Number.isFinite(currentFuel) || currentFuel <= 0) return clampFuel(currentFuel, maxFuel);
  if (!Number.isFinite(deltaKm) || deltaKm <= 0) return clampFuel(currentFuel, maxFuel);

  // Consumo linear (barra 0-100)
  const loss = PERCENT_PER_KM * deltaKm;
  return clampFuel(currentFuel - loss, maxFuel);
}

function clampFuel(value, maxFuel = 100) {
  const v = Number.isFinite(value) ? value : 0;
  const max = Number.isFinite(maxFuel) && maxFuel > 0 ? maxFuel : 100;
  return Math.max(0, Math.min(max, v));
}

module.exports = { computeFuel, clampFuel };
