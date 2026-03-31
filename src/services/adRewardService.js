const { prisma } = require("../db/prisma");
const { applyCoinDelta } = require("./coinService");

function parsePositiveIntEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegIntEnv(key, fallback) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const DEFAULT_COINS = parsePositiveIntEnv("AD_REWARD_COINS_PER_VIEW", 10);
const MAX_COINS_CAP = parsePositiveIntEnv("AD_REWARD_MAX_COINS_PER_CLAIM", 100);
const MAX_PER_HOUR = parseNonNegIntEnv("AD_REWARD_MAX_PER_HOUR", 30);
const TOKEN_MIN = 8;
const TOKEN_MAX = 256;

/**
 * Crédito por recompensa de anúncio (AdMob etc.).
 * Idempotência: mesmo `clientRewardToken` por usuário não credita duas vezes.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.clientRewardToken — UUID ou string opaca gerada no cliente no momento do onUserEarnedReward
 * @param {string} [params.rewardUnitId] — opcional (ex.: placement / ad unit id)
 * @param {string} [params.colyseusRoomId]
 * @param {number} [params.amountOverride] — só usado se AD_REWARD_TRUST_CLIENT_AMOUNT=true
 * @returns {Promise<{ duplicate: boolean, balance: number, amount: number }>}
 */
async function claimAdReward(params) {
  const { userId, clientRewardToken, rewardUnitId = null, colyseusRoomId = null, amountOverride = null } = params;

  if (!userId || typeof userId !== "string") {
    const err = new Error("userId required");
    err.code = "INVALID_USER";
    throw err;
  }

  const token = String(clientRewardToken ?? "").trim();
  if (token.length < TOKEN_MIN || token.length > TOKEN_MAX) {
    const err = new Error("clientRewardToken invalid");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  let amount = DEFAULT_COINS;
  const trustClient = String(process.env.AD_REWARD_TRUST_CLIENT_AMOUNT ?? "false").toLowerCase() === "true";
  if (trustClient && amountOverride != null) {
    const n = Math.floor(Number(amountOverride));
    if (Number.isFinite(n) && n > 0) {
      amount = Math.min(n, MAX_COINS_CAP);
    }
  }

  if (MAX_PER_HOUR > 0) {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await prisma.coinTransaction.count({
      where: {
        userId,
        type: "AD_REWARD",
        createdAt: { gte: since },
      },
    });
    if (recent >= MAX_PER_HOUR) {
      const err = new Error("Ad reward rate limit exceeded");
      err.code = "RATE_LIMITED";
      throw err;
    }
  }

  const idempotencyKey = `adreward:${userId}:${token}`;

  /** @type {Record<string, unknown>} */
  const metadata = { source: "admob" };
  if (rewardUnitId != null && String(rewardUnitId).trim()) {
    metadata.rewardUnitId = String(rewardUnitId).trim();
  }

  const result = await applyCoinDelta({
    userId,
    delta: amount,
    type: "AD_REWARD",
    idempotencyKey,
    colyseusRoomId: colyseusRoomId != null ? String(colyseusRoomId) : null,
    metadata,
  });

  return {
    duplicate: !!result.duplicate,
    balance: result.balance,
    amount,
  };
}

module.exports = {
  claimAdReward,
  DEFAULT_COINS,
  MAX_COINS_CAP,
  MAX_PER_HOUR,
};
