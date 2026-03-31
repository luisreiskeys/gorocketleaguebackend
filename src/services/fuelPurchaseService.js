const { Prisma } = require("@prisma/client");
const { prisma } = require("../db/prisma");
const { getFuelEconomyConfig } = require("../config/fuelEconomyConfig");

const IDEMPOTENCY_KEY_MIN = 8;
const IDEMPOTENCY_KEY_MAX = 256;

class FuelPurchaseError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Percentual do tanque ainda vazio: 0–100 (escala da capacidade maxFuel).
 */
function percentTankMissing(currentFuel, maxFuel) {
  const max = Number(maxFuel);
  const cur = Number(currentFuel);
  if (!Number.isFinite(max) || max <= 0) return 0;
  if (!Number.isFinite(cur)) return 100;
  const missing = max - cur;
  if (missing <= 0) return 0;
  return (missing / max) * 100;
}

/**
 * Custo em moedas para comprar `percentOfCapacity` pontos percentuais da capacidade (cada ponto = 1% do tanque).
 */
function computeCoinCostForPercentSlice(percentOfCapacity, coinsPerPercent) {
  const pct = Number(percentOfCapacity);
  const rate = Number(coinsPerPercent);
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  if (!Number.isFinite(rate) || rate <= 0) return Math.ceil(pct);
  return Math.ceil(pct * rate);
}

/**
 * Quanto da capacidade (em % 0–100) será comprado: pedido do cliente limitado ao que ainda cabe.
 * @param {number|null|undefined} percentToAdd — % da capacidade total a adicionar; null/undefined = encher o restante todo
 */
function resolvePercentSliceToPurchase(percentToAdd, percentMissing) {
  const missing = Number(percentMissing);
  if (!Number.isFinite(missing) || missing <= 0) return 0;

  if (percentToAdd == null || percentToAdd === "") {
    return missing;
  }

  const req = Number(percentToAdd);
  if (!Number.isFinite(req)) {
    return null;
  }
  if (req <= 0) {
    return null;
  }

  return Math.min(req, missing);
}

/**
 * Converte "N% da capacidade" em unidades de fuel (ex.: max 100, 32% → +32 unidades).
 */
function fuelUnitsForPercentOfCapacity(percentOfCapacity, maxFuel) {
  const max = Number(maxFuel);
  const p = Number(percentOfCapacity);
  if (!Number.isFinite(max) || max <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0) return 0;
  return (p / 100) * max;
}

/**
 * Compra combustível com moedas (parcial ou até encher).
 *
 * - **Sem `percentToAdd`:** compra todo o espaço vazio (comportamento anterior).
 * - **Com `percentToAdd`:** adiciona até esse **% da capacidade total** do tanque (ex.: 32 → +32% do max em unidades de combustível), limitado ao que ainda cabe.
 *
 * Preço = ceil(percentEfetivo × fuelPurchaseCoinsPerPercent).
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.idempotencyKey]
 * @param {string} [params.colyseusRoomId]
 * @param {string|null} [params.roomCell]
 * @param {number|null|undefined} [params.percentToAdd] — % da capacidade a comprar; omitir = full top-up
 */
async function purchaseFuelWithCoins(params) {
  const {
    userId,
    idempotencyKey = null,
    colyseusRoomId = null,
    roomCell = null,
    percentToAdd = undefined,
  } = params;

  if (!userId || typeof userId !== "string") {
    throw new FuelPurchaseError("userId required", "INVALID_USER");
  }

  let normalizedKey = null;
  if (idempotencyKey != null && String(idempotencyKey).trim() !== "") {
    normalizedKey = String(idempotencyKey).trim();
    if (normalizedKey.length < IDEMPOTENCY_KEY_MIN || normalizedKey.length > IDEMPOTENCY_KEY_MAX) {
      throw new FuelPurchaseError("idempotencyKey invalid length", "INVALID_IDEMPOTENCY_KEY");
    }
  }

  const { maxFuel, fuelPurchaseCoinsPerPercent: coinsPerPercent } = getFuelEconomyConfig(roomCell);

  return prisma.$transaction(async (tx) => {
    const userExists = await tx.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!userExists) {
      throw new FuelPurchaseError("User not found", "USER_NOT_FOUND");
    }

    await tx.wallet.upsert({
      where: { userId },
      create: { userId, balance: 0 },
      update: {},
    });

    await tx.$executeRaw(Prisma.sql`SELECT 1 FROM wallets WHERE user_id = ${userId} FOR UPDATE`);

    if (normalizedKey) {
      const existing = await tx.coinTransaction.findFirst({
        where: { userId, idempotencyKey: normalizedKey },
      });
      if (existing) {
        const wallet = await tx.wallet.findUnique({ where: { userId } });
        const userRow = await tx.user.findUnique({
          where: { id: userId },
          select: { fuel: true },
        });
        const fuelNow = Number(userRow?.fuel ?? 0);
        const meta = existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {};
        const prevPurchased = meta.percentPurchased != null ? Number(meta.percentPurchased) : null;
        return {
          duplicate: true,
          balance: wallet?.balance ?? 0,
          fuel: fuelNow,
          coinsSpent: Math.abs(Number(existing.amount)),
          maxFuel,
          percentMissing: percentTankMissing(fuelNow, maxFuel),
          percentPurchased: Number.isFinite(prevPurchased) ? prevPurchased : null,
        };
      }
    }

    const userRow = await tx.user.findUnique({
      where: { id: userId },
      select: { fuel: true },
    });
    const currentFuel = Number(userRow?.fuel ?? 0);
    if (currentFuel >= maxFuel - 1e-6) {
      throw new FuelPurchaseError("Fuel tank already full", "ALREADY_FULL");
    }

    const percentMissing = percentTankMissing(currentFuel, maxFuel);
    const effectiveSlice = resolvePercentSliceToPurchase(percentToAdd, percentMissing);

    if (effectiveSlice === null) {
      throw new FuelPurchaseError("percentToAdd must be a positive number", "INVALID_PERCENT");
    }
    if (effectiveSlice <= 0) {
      throw new FuelPurchaseError("Fuel tank already full", "ALREADY_FULL");
    }

    const coinCost = computeCoinCostForPercentSlice(effectiveSlice, coinsPerPercent);
    if (coinCost <= 0) {
      throw new FuelPurchaseError("Fuel tank already full", "ALREADY_FULL");
    }

    const fuelDelta = fuelUnitsForPercentOfCapacity(effectiveSlice, maxFuel);
    let newFuel = currentFuel + fuelDelta;
    newFuel = Math.min(maxFuel, newFuel);
    if (newFuel > maxFuel - 1e-6) {
      newFuel = maxFuel;
    }

    const walletBefore = await tx.wallet.findUnique({ where: { userId } });
    if (!walletBefore || walletBefore.balance < coinCost) {
      throw new FuelPurchaseError("Insufficient coins", "INSUFFICIENT_COINS");
    }

    const updatedWallet = await tx.wallet.updateMany({
      where: { userId, balance: { gte: coinCost } },
      data: { balance: { increment: -coinCost } },
    });
    if (updatedWallet.count !== 1) {
      throw new FuelPurchaseError("Insufficient coins", "INSUFFICIENT_COINS");
    }

    await tx.user.update({
      where: { id: userId },
      data: { fuel: newFuel },
    });

    const walletAfter = await tx.wallet.findUnique({ where: { userId } });

    await tx.coinTransaction.create({
      data: {
        userId,
        type: "PURCHASE",
        amount: -coinCost,
        balanceAfter: walletAfter.balance,
        idempotencyKey: normalizedKey,
        colyseusRoomId: colyseusRoomId != null && String(colyseusRoomId) ? String(colyseusRoomId) : null,
        metadata: {
          kind: "fuel_refill",
          fuelBefore: currentFuel,
          fuelAfter: newFuel,
          maxFuel,
          coinCost,
          coinsPerPercent,
          percentTankMissingBefore: Number(percentMissing.toFixed(4)),
          percentPurchased: Number(effectiveSlice.toFixed(4)),
          percentToAddRequested:
            percentToAdd == null || percentToAdd === "" ? null : Number(percentToAdd),
        },
      },
    });

    return {
      duplicate: false,
      balance: walletAfter.balance,
      fuel: newFuel,
      coinsSpent: coinCost,
      maxFuel,
      percentMissing,
      percentPurchased: effectiveSlice,
    };
  });
}

module.exports = {
  purchaseFuelWithCoins,
  FuelPurchaseError,
  percentTankMissing,
  computeCoinCostForPercentSlice,
  resolvePercentSliceToPurchase,
  fuelUnitsForPercentOfCapacity,
};
