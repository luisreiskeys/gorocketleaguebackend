const XP_PER_KM = Number(process.env.XP_PER_KM ?? "1");
const XP_PER_FLAG_CAPTURE = Number(process.env.XP_PER_FLAG_CAPTURE ?? "10");

function clampNonNegativeInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.floor(v);
}

function computeDistanceXp(deltaKm, accumulatedKmRemainder = 0) {
  const delta = Number(deltaKm);
  const prevRemainder = Number(accumulatedKmRemainder);
  const safeRemainder = Number.isFinite(prevRemainder) && prevRemainder > 0 ? prevRemainder : 0;

  if (!Number.isFinite(delta) || delta <= 0) {
    return {
      xpGained: 0,
      remainderKm: safeRemainder,
    };
  }

  const totalKm = safeRemainder + delta;
  const wholeKm = Math.floor(totalKm);
  const xpPerKm = clampNonNegativeInt(XP_PER_KM);

  return {
    xpGained: wholeKm * xpPerKm,
    remainderKm: totalKm - wholeKm,
  };
}

function computeOwnershipXp(flagCaptures = 1) {
  const count = clampNonNegativeInt(flagCaptures);
  const xpPerFlag = clampNonNegativeInt(XP_PER_FLAG_CAPTURE);
  return count * xpPerFlag;
}

module.exports = {
  computeDistanceXp,
  computeOwnershipXp,
};
