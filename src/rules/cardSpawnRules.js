function classifyPlayerRarity(player, cfg) {
  const ovr = Number(player?.ovr ?? 0);
  if (!Number.isFinite(ovr) || ovr <= 0) return "common";
  if (ovr <= Number(cfg.commonMaxOvr)) return "common";
  if (ovr <= Number(cfg.specialMaxOvr)) return "special";
  return "rare";
}

function pickWeightedBucket(cfg, rng = Math.random) {
  const wc = Math.max(0, Number(cfg.weightCommon) || 0);
  const ws = Math.max(0, Number(cfg.weightSpecial) || 0);
  const wr = Math.max(0, Number(cfg.weightRare) || 0);
  const total = wc + ws + wr;
  if (total <= 0) return "common";

  const roll = rng() * total;
  if (roll < wr) return "rare";
  if (roll < wr + ws) return "special";
  return "common";
}

function pickRandomItem(list, rng = Math.random) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = Math.floor(rng() * list.length);
  return list[Math.max(0, Math.min(list.length - 1, idx))] || null;
}

module.exports = {
  classifyPlayerRarity,
  pickWeightedBucket,
  pickRandomItem,
};
