const { Prisma } = require("@prisma/client");
const { prisma } = require("../db/prisma");

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;

class InsufficientCoinsError extends Error {
  constructor(message = "Insufficient coins") {
    super(message);
    this.name = "InsufficientCoinsError";
    this.code = "INSUFFICIENT_COINS";
  }
}

class InvalidCoinAmountError extends Error {
  constructor(message = "Invalid coin amount") {
    super(message);
    this.name = "InvalidCoinAmountError";
    this.code = "INVALID_COIN_AMOUNT";
  }
}

function assertInt32(n, label) {
  if (!Number.isInteger(n) || n < INT32_MIN || n > INT32_MAX) {
    throw new InvalidCoinAmountError(`${label} out of int32 range`);
  }
}

/**
 * Crédito ou débito atômico com lock na wallet e suporte a idempotência.
 * @param {Object} params
 * @param {string} params.userId
 * @param {number} params.delta — positivo = crédito, negativo = débito
 * @param {import("@prisma/client").CoinTransactionType} params.type
 * @param {string} [params.idempotencyKey]
 * @param {string} [params.externalRef]
 * @param {import("@prisma/client").Prisma.JsonValue} [params.metadata]
 * @param {string} [params.colyseusRoomId]
 * @returns {Promise<{ duplicate: boolean, balance: number, transaction: import("@prisma/client").CoinTransaction }>}
 */
async function applyCoinDelta(params) {
  const {
    userId,
    delta,
    type,
    idempotencyKey = null,
    externalRef = null,
    metadata = undefined,
    colyseusRoomId = null,
  } = params;

  if (!userId || typeof userId !== "string") {
    throw new InvalidCoinAmountError("userId required");
  }
  assertInt32(delta, "delta");
  if (delta === 0) {
    throw new InvalidCoinAmountError("delta cannot be 0");
  }

  let normalizedKey = null;
  if (idempotencyKey != null) {
    normalizedKey = String(idempotencyKey).trim();
    if (!normalizedKey) {
      throw new InvalidCoinAmountError("idempotencyKey cannot be empty");
    }
  }

  return prisma.$transaction(async (tx) => {
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
        return {
          duplicate: true,
          balance: wallet.balance,
          transaction: existing,
        };
      }
    }

    const walletBefore = await tx.wallet.findUnique({ where: { userId } });
    if (!walletBefore) {
      throw new Error("Wallet missing after upsert");
    }

    if (delta > 0) {
      const next = walletBefore.balance + delta;
      if (next > INT32_MAX) {
        throw new InvalidCoinAmountError("credit would overflow balance");
      }
      await tx.wallet.update({
        where: { userId },
        data: { balance: { increment: delta } },
      });
    } else {
      const abs = -delta;
      if (walletBefore.balance < abs) {
        throw new InsufficientCoinsError();
      }
      const updated = await tx.wallet.updateMany({
        where: { userId, balance: { gte: abs } },
        data: { balance: { increment: delta } },
      });
      if (updated.count !== 1) {
        throw new InsufficientCoinsError();
      }
    }

    const walletAfter = await tx.wallet.findUnique({ where: { userId } });

    const createData = {
      userId,
      type,
      amount: delta,
      balanceAfter: walletAfter.balance,
      idempotencyKey: normalizedKey,
      externalRef: externalRef != null && String(externalRef).trim() ? String(externalRef).trim() : null,
      colyseusRoomId: colyseusRoomId != null && String(colyseusRoomId) ? String(colyseusRoomId) : null,
    };
    if (metadata !== undefined) {
      createData.metadata = metadata;
    }

    const row = await tx.coinTransaction.create({
      data: createData,
    });

    return {
      duplicate: false,
      balance: walletAfter.balance,
      transaction: row,
    };
  });
}

async function getWalletBalance(userId) {
  const w = await prisma.wallet.findUnique({ where: { userId } });
  return w ? w.balance : 0;
}

async function ensureWallet(userId) {
  await prisma.wallet.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });
}

/**
 * @param {string} userId
 * @param {{ limit?: number, offset?: number }} [opts]
 */
async function listCoinTransactions(userId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 20, 1), 100);
  const offset = Math.min(Math.max(Number(opts.offset) || 0, 0), 10_000);

  const [items, total] = await prisma.$transaction([
    prisma.coinTransaction.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      skip: offset,
      select: {
        id: true,
        type: true,
        amount: true,
        balanceAfter: true,
        metadata: true,
        colyseusRoomId: true,
        createdAt: true,
      },
    }),
    prisma.coinTransaction.count({ where: { userId } }),
  ]);

  return { items, total, limit, offset };
}

module.exports = {
  applyCoinDelta,
  getWalletBalance,
  ensureWallet,
  listCoinTransactions,
  InsufficientCoinsError,
  InvalidCoinAmountError,
};
