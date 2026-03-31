const { requireUserToken } = require("../middlewares/auth");
const {
  getWalletBalance,
  ensureWallet,
  listCoinTransactions,
} = require("../services/coinService");
const { claimAdReward } = require("../services/adRewardService");
const { purchaseFuelWithCoins, FuelPurchaseError } = require("../services/fuelPurchaseService");

/**
 * GET /wallet — saldo atual (cria wallet em 0 se ainda não existir, p.ex. users antigos).
 */
async function getWallet(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  try {
    await ensureWallet(userId);
    const balance = await getWalletBalance(userId);
    return reply.send({ userId, balance });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to load wallet",
      message: err.message,
    });
  }
}

/**
 * GET /wallet/transactions?limit=&offset=
 */
async function getWalletTransactions(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const q = request.query || {};
  const limit = q.limit != null ? Number(q.limit) : undefined;
  const offset = q.offset != null ? Number(q.offset) : undefined;

  try {
    await ensureWallet(userId);
    const result = await listCoinTransactions(userId, { limit, offset });
    return reply.send(result);
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list transactions",
      message: err.message,
    });
  }
}

/**
 * POST /wallet/ad-reward
 * Body: { clientRewardToken: string, rewardUnitId?: string, amount?: number }
 * Credita coins após recompensa de anúncio (ex. AdMob). Idempotente por token + usuário.
 */
async function postAdRewardClaim(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const clientRewardToken = body.clientRewardToken ?? body.rewardToken ?? body.token;
  const rewardUnitId = body.rewardUnitId ?? body.adUnitId ?? null;
  const amount = body.amount;

  try {
    await ensureWallet(userId);
    const result = await claimAdReward({
      userId,
      clientRewardToken,
      rewardUnitId,
      amountOverride: amount,
    });
    return reply.send({
      ok: true,
      balance: result.balance,
      amount: result.amount,
      duplicate: result.duplicate,
    });
  } catch (err) {
    const code = err?.code;
    if (code === "INVALID_TOKEN" || code === "INVALID_USER") {
      return reply.code(400).send({ error: err.message, code });
    }
    if (code === "RATE_LIMITED") {
      return reply.code(429).send({ error: err.message, code });
    }
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to claim ad reward",
      message: err.message,
    });
  }
}

/**
 * POST /wallet/purchase-fuel
 * Body: { idempotencyKey?: string, percentToAdd?: number }
 * - Sem `percentToAdd`: compra todo o espaço vazio (até maxFuel).
 * - Com `percentToAdd`: adiciona até esse % da **capacidade total** (ex.: 32 → +32 unidades se max=100), limitado ao vazio.
 */
async function postPurchaseFuel(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const idempotencyKey = body.idempotencyKey ?? body.idempotency_key ?? null;
  const percentToAdd =
    body.percentToAdd !== undefined && body.percentToAdd !== null && body.percentToAdd !== ""
      ? Number(body.percentToAdd)
      : undefined;

  try {
    await ensureWallet(userId);
    const result = await purchaseFuelWithCoins({
      userId,
      idempotencyKey,
      percentToAdd,
    });
    return reply.send({
      ok: true,
      balance: result.balance,
      fuel: result.fuel,
      maxFuel: result.maxFuel,
      coinsSpent: result.coinsSpent,
      /** % do tanque que estava vazio antes desta compra. */
      percentMissing: result.percentMissing,
      /** % da capacidade efetivamente comprados nesta transação (≤ percentToAdd / ≤ percentMissing). */
      percentPurchased: result.percentPurchased,
      duplicate: result.duplicate,
    });
  } catch (err) {
    if (err instanceof FuelPurchaseError) {
      const code = err.code;
      if (code === "ALREADY_FULL") {
        return reply.code(409).send({ error: err.message, code });
      }
      if (code === "INSUFFICIENT_COINS") {
        return reply.code(400).send({ error: err.message, code });
      }
      if (code === "INVALID_PERCENT") {
        return reply.code(400).send({ error: err.message, code });
      }
      if (code === "INVALID_IDEMPOTENCY_KEY" || code === "INVALID_USER") {
        return reply.code(400).send({ error: err.message, code });
      }
      if (code === "USER_NOT_FOUND") {
        return reply.code(404).send({ error: err.message, code });
      }
    }
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to purchase fuel",
      message: err.message,
    });
  }
}

async function walletRoutes(fastify) {
  fastify.get("/wallet", { preHandler: requireUserToken }, getWallet);
  fastify.get("/wallet/transactions", { preHandler: requireUserToken }, getWalletTransactions);
  fastify.post("/wallet/ad-reward", { preHandler: requireUserToken }, postAdRewardClaim);
  fastify.post("/wallet/purchase-fuel", { preHandler: requireUserToken }, postPurchaseFuel);
}

module.exports = walletRoutes;
