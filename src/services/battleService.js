const { randomUUID } = require("crypto");
const { Prisma } = require("@prisma/client");
const { getSerialClass, mintInstanceWithSerial } = require("./cardInstanceMintService");
const {
  calculateTeamOverallFromInstances,
  recordTeamMatchResult,
  applyOpenBattleAutoDisableIfNeeded,
} = require("./teamService");
const { incrementPlayerFoundProgress } = require("./playerProgressService");
const { getCardSpawnConfig } = require("../config/cardSpawnConfig");
const { rollCardId, createRarityPool } = require("./cardSpawnService");
const { mapInstanceRow, INSTANCE_FULL_SELECT } = require("./instanceApiMapper");
const { teamShieldPublicUrl } = require("./teamShieldService");

const BATTLE_TIER_TO_COINS = Object.freeze({
  COINS_10: 10,
  COINS_50: 50,
  COINS_100: 100,
  COINS_1000: 1000,
});

const WINNER_XP_BY_TIER = Object.freeze({
  COINS_10: 35,
  COINS_50: 42,
  COINS_100: 50,
  COINS_1000: 70,
});

const LOSER_XP_BY_TIER = Object.freeze({
  COINS_10: 12,
  COINS_50: 15,
  COINS_100: 18,
  COINS_1000: 22,
});

const EXPIRATION_HOURS = 24;

function err(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function normalizeTier(value) {
  const tier = String(value || "").trim().toUpperCase();
  return tier in BATTLE_TIER_TO_COINS ? tier : null;
}

function mapSnapshotInstance(row) {
  return {
    id: row.id,
    cardId: row.cardId,
    serialNumber: row.serialNumber,
    serialMax: row.serialMax,
    serialLabel: `${row.serialNumber}/${row.serialMax}`,
    serialClass: getSerialClass(row.serialNumber, row.serialMax),
    card: {
      id: row.card.id,
      name: row.card.name,
      ovr: row.card.ovr,
      nation: row.card.nation,
      team: row.card.team,
      url: row.card.url,
    },
  };
}

async function loadTeamSnapshot(tx, userId) {
  const team = await tx.team.findUnique({
    where: { userId: String(userId) },
    select: {
      id: true,
      name: true,
      overall: true,
      slots: {
        orderBy: { slotIndex: "asc" },
        select: {
          slotIndex: true,
          instance: {
            select: {
              id: true,
              cardId: true,
              serialNumber: true,
              serialMax: true,
              card: {
                select: {
                  id: true,
                  name: true,
                  ovr: true,
                  nation: true,
                  team: true,
                  url: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!team || team.slots.length !== 5) {
    throw err("BATTLE_TEAM_NOT_READY", "Both players must have a full team with 5 slots");
  }

  const rows = team.slots.map((s) => ({
    cardId: s.instance.cardId,
    card: { ovr: s.instance.card.ovr, nation: s.instance.card.nation },
  }));
  const breakdown = calculateTeamOverallFromInstances(rows);

  return {
    teamId: team.id,
    teamName: team.name,
    overall: breakdown.overall,
    baseOverallSum: breakdown.baseSum,
    nationalityBonusPercent: breakdown.nationalityBonusPercent,
    maxSameNationCount: breakdown.maxSameNationCount,
    nationalitySynergy: breakdown.nationalitySynergy,
    slots: team.slots.map((s) => ({
      slotIndex: s.slotIndex,
      instance: mapSnapshotInstance(s.instance),
    })),
  };
}

async function ensureWalletAndLock(tx, userId) {
  await tx.wallet.upsert({
    where: { userId },
    create: { userId, balance: 0 },
    update: {},
  });
  await tx.$executeRaw(Prisma.sql`SELECT 1 FROM wallets WHERE user_id = ${userId} FOR UPDATE`);
}

async function applyCoinDeltaTx(tx, { userId, delta, type, externalRef, metadata }) {
  if (!Number.isInteger(delta) || delta === 0) {
    throw err("BATTLE_INVALID_COINS", "Invalid coin delta");
  }

  await ensureWalletAndLock(tx, userId);
  const walletBefore = await tx.wallet.findUnique({ where: { userId } });
  if (!walletBefore) {
    throw err("BATTLE_WALLET_NOT_FOUND", "Wallet not found");
  }
  if (delta < 0 && walletBefore.balance < -delta) {
    throw err("BATTLE_INSUFFICIENT_COINS", "Insufficient coins for this battle tier");
  }

  await tx.wallet.update({
    where: { userId },
    data: { balance: { increment: delta } },
  });

  const walletAfter = await tx.wallet.findUnique({ where: { userId } });
  await tx.coinTransaction.create({
    data: {
      userId,
      type,
      amount: delta,
      balanceAfter: walletAfter.balance,
      externalRef: externalRef || null,
      metadata: metadata || undefined,
    },
  });
}

function createBattleRng(challengeId) {
  let seed = 0;
  const text = String(challengeId || "");
  for (let i = 0; i < text.length; i += 1) {
    seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  }
  if (seed === 0) seed = 123456789;
  return () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function resolveBattleOutcome(challengeId, challengerSnapshot, challengedSnapshot) {
  const rng = createBattleRng(challengeId);
  const challengerVariance = 0.95 + rng() * 0.1;
  const challengedVariance = 0.95 + rng() * 0.1;
  const challengerPower = challengerSnapshot.overall * challengerVariance;
  const challengedPower = challengedSnapshot.overall * challengedVariance;

  if (challengerPower === challengedPower) {
    return rng() < 0.5 ? "challenger" : "challenged";
  }
  return challengerPower > challengedPower ? "challenger" : "challenged";
}

async function mintBattleRewardCard(tx, winnerUserId) {
  const winner = await tx.user.findUnique({
    where: { id: winnerUserId },
    select: { id: true, lat: true, lng: true, h3RoomCell: true },
  });
  if (!winner) return null;

  const cfg = getCardSpawnConfig();
  const rarityPool = await createRarityPool(cfg);
  const cardId = await rollCardId(cfg, rarityPool);
  if (!cardId) return null;

  const lat = Number(winner.lat ?? 0);
  const lng = Number(winner.lng ?? 0);
  const created = await mintInstanceWithSerial(tx, {
    cardId,
    ownerId: winner.id,
    latitude: Number.isFinite(lat) ? lat : 0,
    longitude: Number.isFinite(lng) ? lng : 0,
    h3RoomCell: winner.h3RoomCell ? String(winner.h3RoomCell) : null,
    spawnSource: "battle_reward",
    foundWhen: new Date(),
    foundWhereLat: Number.isFinite(lat) ? lat : null,
    foundWhereLng: Number.isFinite(lng) ? lng : null,
  });
  await incrementPlayerFoundProgress(tx, created.cardId, 1);
  return created.id;
}

async function createBattleChallenge(prisma, params) {
  const challengerId = String(params.challengerId);
  const challengedId = String(params.challengedId);
  const stakeTier = normalizeTier(params.stakeTier);
  if (!stakeTier) {
    throw err("BATTLE_INVALID_TIER", "stakeTier must be one of: COINS_10, COINS_50, COINS_100, COINS_1000");
  }
  if (challengerId === challengedId) {
    throw err("BATTLE_SELF", "Cannot challenge yourself");
  }
  const stakeCoins = BATTLE_TIER_TO_COINS[stakeTier];

  const challenged = await prisma.user.findUnique({
    where: { id: challengedId },
    select: { id: true },
  });
  if (!challenged) {
    throw err("BATTLE_USER_NOT_FOUND", "Challenged user not found");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXPIRATION_HOURS * 60 * 60 * 1000);
  return prisma.$transaction(async (tx) => {
    const challengerSnapshot = await loadTeamSnapshot(tx, challengerId);
    const challengedSnapshot = await loadTeamSnapshot(tx, challengedId);

    await applyCoinDeltaTx(tx, {
      userId: challengerId,
      delta: -stakeCoins,
      type: "BATTLE_STAKE",
      metadata: { role: "challenger", stakeTier, stakeCoins },
    });

    const created = await tx.battleChallenge.create({
      data: {
        challengerId,
        challengedId,
        status: "PENDING",
        stakeTier,
        stakeCoins,
        challengerSnapshot,
        challengedSnapshot,
        expiresAt,
      },
      select: { id: true },
    });
    await applyOpenBattleAutoDisableIfNeeded(tx, challengerId);
    return created.id;
  });
}

async function getBattleChallengeForUser(prisma, id, userId) {
  return prisma.battleChallenge.findFirst({
    where: {
      id: String(id),
      OR: [{ challengerId: String(userId) }, { challengedId: String(userId) }],
    },
    include: {
      challenger: { select: { id: true, username: true, avatarId: true } },
      challenged: { select: { id: true, username: true, avatarId: true } },
      winner: { select: { id: true, username: true, avatarId: true } },
      loser: { select: { id: true, username: true, avatarId: true } },
      rewardCardInstance: {
        select: {
          id: true,
          cardId: true,
          serialNumber: true,
          serialMax: true,
          card: { select: { id: true, name: true, ovr: true, nation: true, team: true, url: true } },
        },
      },
    },
  });
}

async function listBattleChallengesForUser(prisma, q) {
  const userId = String(q.userId);
  const role = q.role || "all";
  const take = Math.min(Math.max(Number(q.take) || 50, 1), 100);
  const skip = Math.max(Number(q.skip) || 0, 0);
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(role === "challenger"
      ? { challengerId: userId }
      : role === "challenged"
        ? { challengedId: userId }
        : { OR: [{ challengerId: userId }, { challengedId: userId }] }),
  };
  const [items, total] = await prisma.$transaction([
    prisma.battleChallenge.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        challenger: { select: { id: true, username: true, avatarId: true } },
        challenged: { select: { id: true, username: true, avatarId: true } },
        winner: { select: { id: true, username: true, avatarId: true } },
        loser: { select: { id: true, username: true, avatarId: true } },
      },
    }),
    prisma.battleChallenge.count({ where }),
  ]);
  return { items, total, take, skip };
}

async function resolveExpiredPending(tx, challenge) {
  if (challenge.status !== "PENDING") return false;
  if (challenge.expiresAt > new Date()) return false;

  await applyCoinDeltaTx(tx, {
    userId: challenge.challengerId,
    delta: challenge.stakeCoins,
    type: "BATTLE_STAKE_REFUND",
    externalRef: `battle:${challenge.id}`,
    metadata: { reason: "expired_refund", stakeCoins: challenge.stakeCoins },
  });

  await tx.battleChallenge.update({
    where: { id: challenge.id },
    data: { status: "EXPIRED" },
  });
  return true;
}

async function acceptBattleChallenge(prisma, battleId, challengedId) {
  const id = String(battleId);
  const uid = String(challengedId);
  return prisma.$transaction(async (tx) => {
    const challenge = await tx.battleChallenge.findFirst({
      where: { id, challengedId: uid, status: "PENDING" },
    });
    if (!challenge) {
      throw err("BATTLE_NOT_FOUND", "Battle challenge not found or not pending for you");
    }

    const expired = await resolveExpiredPending(tx, challenge);
    if (expired) {
      throw err("BATTLE_EXPIRED", "Battle challenge has expired");
    }

    await applyCoinDeltaTx(tx, {
      userId: uid,
      delta: -challenge.stakeCoins,
      type: "BATTLE_STAKE",
      externalRef: `battle:${challenge.id}`,
      metadata: { role: "challenged", stakeTier: challenge.stakeTier, stakeCoins: challenge.stakeCoins },
    });

    const challengerSnapshot = challenge.challengerSnapshot;
    const challengedSnapshot = challenge.challengedSnapshot;
    const winnerSide = resolveBattleOutcome(challenge.id, challengerSnapshot, challengedSnapshot);
    const winnerUserId = winnerSide === "challenger" ? challenge.challengerId : challenge.challengedId;
    const loserUserId = winnerSide === "challenger" ? challenge.challengedId : challenge.challengerId;
    const winnerSnapshot = winnerSide === "challenger" ? challengerSnapshot : challengedSnapshot;
    const loserSnapshot = winnerSide === "challenger" ? challengedSnapshot : challengerSnapshot;
    const pot = challenge.stakeCoins * 2;

    await applyCoinDeltaTx(tx, {
      userId: winnerUserId,
      delta: pot,
      type: "BATTLE_WIN_POT",
      externalRef: `battle:${challenge.id}`,
      metadata: { pot, stakeCoins: challenge.stakeCoins, stakeTier: challenge.stakeTier },
    });

    const winnerXp = WINNER_XP_BY_TIER[challenge.stakeTier] ?? 40;
    const loserXp = LOSER_XP_BY_TIER[challenge.stakeTier] ?? 15;
    await tx.user.update({
      where: { id: winnerUserId },
      data: { xp: { increment: winnerXp } },
    });
    await tx.user.update({
      where: { id: loserUserId },
      data: { xp: { increment: loserXp } },
    });

    await recordTeamMatchResult(tx, winnerSnapshot.teamId, "win");
    await recordTeamMatchResult(tx, loserSnapshot.teamId, "loss");

    const rewardCardInstanceId = await mintBattleRewardCard(tx, winnerUserId);
    await tx.battleChallenge.update({
      where: { id: challenge.id },
      data: {
        status: "RESOLVED",
        acceptedAt: new Date(),
        resolvedAt: new Date(),
        winnerId: winnerUserId,
        loserId: loserUserId,
        rewardCardInstanceId: rewardCardInstanceId || null,
      },
    });
    await applyOpenBattleAutoDisableIfNeeded(tx, challenge.challengerId);
    await applyOpenBattleAutoDisableIfNeeded(tx, challenge.challengedId);
    return challenge.id;
  });
}

/**
 * Duelo imediato contra um time que está "aberto" (openForBattle + tier).
 * Não cria convite: debita os dois stakes, resolve e grava batalha como RESOLVED.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ challengerId: string, challengedId: string, stakeTier?: string | null }} params
 */
async function instantOpenBattle(prisma, params) {
  const challengerId = String(params.challengerId);
  const challengedId = String(params.challengedId);
  if (challengerId === challengedId) {
    throw err("BATTLE_SELF", "Cannot battle yourself");
  }

  const challengedUser = await prisma.user.findUnique({
    where: { id: challengedId },
    select: { id: true },
  });
  if (!challengedUser) {
    throw err("BATTLE_USER_NOT_FOUND", "Opponent user not found");
  }

  return prisma.$transaction(async (tx) => {
    const challengedTeam = await tx.team.findUnique({
      where: { userId: challengedId },
      select: {
        openForBattle: true,
        openBattleStakeTier: true,
      },
    });

    if (!challengedTeam?.openForBattle || !challengedTeam.openBattleStakeTier) {
      throw err(
        "BATTLE_OPEN_NOT_AVAILABLE",
        "Opponent team is not open for battle with a stake tier",
      );
    }

    const stakeTier = challengedTeam.openBattleStakeTier;
    if (params.stakeTier != null && String(params.stakeTier).trim() !== "") {
      const requested = normalizeTier(params.stakeTier);
      if (!requested || requested !== stakeTier) {
        throw err(
          "BATTLE_TIER_MISMATCH",
          "stakeTier must match the opponent's open battle tier",
        );
      }
    }

    const stakeCoins = BATTLE_TIER_TO_COINS[stakeTier];
    if (!stakeCoins) {
      throw err("BATTLE_INVALID_TIER", "Invalid opponent stake tier");
    }

    await ensureWalletAndLock(tx, challengedId);
    const oppWallet = await tx.wallet.findUnique({ where: { userId: challengedId } });
    if (!oppWallet || oppWallet.balance < stakeCoins) {
      throw err(
        "BATTLE_OPPONENT_INSUFFICIENT_COINS",
        "Opponent cannot cover this stake right now",
      );
    }

    const challengerSnapshot = await loadTeamSnapshot(tx, challengerId);
    const challengedSnapshot = await loadTeamSnapshot(tx, challengedId);

    const battleId = randomUUID();
    const winnerSide = resolveBattleOutcome(battleId, challengerSnapshot, challengedSnapshot);
    const winnerUserId = winnerSide === "challenger" ? challengerId : challengedId;
    const loserUserId = winnerSide === "challenger" ? challengedId : challengerId;
    const winnerSnapshot = winnerSide === "challenger" ? challengerSnapshot : challengedSnapshot;
    const loserSnapshot = winnerSide === "challenger" ? challengedSnapshot : challengerSnapshot;
    const pot = stakeCoins * 2;

    await applyCoinDeltaTx(tx, {
      userId: challengerId,
      delta: -stakeCoins,
      type: "BATTLE_STAKE",
      externalRef: `battle:${battleId}`,
      metadata: { role: "challenger", mode: "instant_open", stakeTier, stakeCoins },
    });
    await applyCoinDeltaTx(tx, {
      userId: challengedId,
      delta: -stakeCoins,
      type: "BATTLE_STAKE",
      externalRef: `battle:${battleId}`,
      metadata: { role: "challenged", mode: "instant_open", stakeTier, stakeCoins },
    });

    await applyCoinDeltaTx(tx, {
      userId: winnerUserId,
      delta: pot,
      type: "BATTLE_WIN_POT",
      externalRef: `battle:${battleId}`,
      metadata: { pot, stakeCoins, stakeTier, mode: "instant_open" },
    });

    const winnerXp = WINNER_XP_BY_TIER[stakeTier] ?? 40;
    const loserXp = LOSER_XP_BY_TIER[stakeTier] ?? 15;
    await tx.user.update({
      where: { id: winnerUserId },
      data: { xp: { increment: winnerXp } },
    });
    await tx.user.update({
      where: { id: loserUserId },
      data: { xp: { increment: loserXp } },
    });

    await recordTeamMatchResult(tx, winnerSnapshot.teamId, "win");
    await recordTeamMatchResult(tx, loserSnapshot.teamId, "loss");

    const rewardCardInstanceId = await mintBattleRewardCard(tx, winnerUserId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRATION_HOURS * 60 * 60 * 1000);

    await tx.battleChallenge.create({
      data: {
        id: battleId,
        challengerId,
        challengedId,
        status: "RESOLVED",
        stakeTier,
        stakeCoins,
        challengerSnapshot,
        challengedSnapshot,
        expiresAt,
        acceptedAt: now,
        resolvedAt: now,
        winnerId: winnerUserId,
        loserId: loserUserId,
        rewardCardInstanceId: rewardCardInstanceId || null,
      },
    });

    await applyOpenBattleAutoDisableIfNeeded(tx, challengerId);
    await applyOpenBattleAutoDisableIfNeeded(tx, challengedId);

    return {
      battleId,
      winnerUserId,
      loserUserId,
      winnerXp,
      loserXp,
      pot,
      stakeCoins,
      stakeTier,
    };
  });
}

async function declineOrCancelBattleChallenge(prisma, battleId, userId, action) {
  const id = String(battleId);
  const uid = String(userId);
  return prisma.$transaction(async (tx) => {
    const challenge = await tx.battleChallenge.findFirst({
      where: {
        id,
        status: "PENDING",
        ...(action === "decline" ? { challengedId: uid } : { challengerId: uid }),
      },
    });
    if (!challenge) {
      throw err("BATTLE_NOT_FOUND", "Battle challenge not found, not pending, or not allowed for this user");
    }

    const expired = await resolveExpiredPending(tx, challenge);
    if (expired) {
      throw err("BATTLE_EXPIRED", "Battle challenge has expired");
    }

    await applyCoinDeltaTx(tx, {
      userId: challenge.challengerId,
      delta: challenge.stakeCoins,
      type: "BATTLE_STAKE_REFUND",
      externalRef: `battle:${challenge.id}`,
      metadata: { reason: action === "decline" ? "declined_refund" : "cancelled_refund" },
    });
    await tx.battleChallenge.update({
      where: { id: challenge.id },
      data: { status: action === "decline" ? "DECLINED" : "CANCELLED" },
    });
    return challenge.id;
  });
}

/**
 * Carrega instâncias atuais do banco (mesmo formato que `GET /user/team`) para reveal pós-batalha.
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ challengerSnapshot: object, challengedSnapshot: object, challengerId: string, challengedId: string }} p
 */
async function buildBattleTeamsReveal(prisma, p) {
  const challengerSnapshot = p.challengerSnapshot;
  const challengedSnapshot = p.challengedSnapshot;
  if (!challengerSnapshot?.slots?.length || !challengedSnapshot?.slots?.length) {
    throw err("BATTLE_SNAPSHOT_INVALID", "Invalid battle snapshots");
  }

  const ids = [];
  for (const snap of [challengerSnapshot, challengedSnapshot]) {
    for (const s of snap.slots) {
      const id = s?.instance?.id;
      if (id) ids.push(String(id));
    }
  }
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== 10) {
    throw err("BATTLE_SNAPSHOT_INVALID", "Battle snapshots must reference 10 instances");
  }

  const rows = await prisma.instance.findMany({
    where: { id: { in: uniqueIds } },
    select: INSTANCE_FULL_SELECT,
  });
  if (rows.length !== uniqueIds.length) {
    throw err("BATTLE_INSTANCE_NOT_FOUND", "One or more battle instances are missing");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));

  const teamIds = [challengerSnapshot.teamId, challengedSnapshot.teamId].filter(Boolean);
  const teamRows = await prisma.team.findMany({
    where: { id: { in: teamIds } },
    select: { id: true, shieldId: true, wins: true, losses: true },
  });
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  function buildSide(snapshot, userId) {
    const t = teamById.get(snapshot.teamId);
    const ordered = [...snapshot.slots].sort((a, b) => a.slotIndex - b.slotIndex);
    const slots = ordered.map((s) => {
      const row = byId.get(String(s.instance?.id));
      if (!row) {
        throw err("BATTLE_INSTANCE_NOT_FOUND", "Instance missing for battle reveal");
      }
      return {
        slotIndex: s.slotIndex,
        instance: mapInstanceRow(row),
      };
    });
    return {
      userId: String(userId),
      teamId: snapshot.teamId,
      teamName: snapshot.teamName,
      overall: snapshot.overall,
      baseOverallSum: snapshot.baseOverallSum,
      nationalityBonusPercent: snapshot.nationalityBonusPercent,
      maxSameNationCount: snapshot.maxSameNationCount,
      nationalitySynergy: snapshot.nationalitySynergy,
      shieldId: t?.shieldId ?? null,
      shieldUrl: teamShieldPublicUrl(t?.shieldId ?? null),
      wins: t?.wins ?? 0,
      losses: t?.losses ?? 0,
      slots,
    };
  }

  return {
    challenger: buildSide(challengerSnapshot, p.challengerId),
    challenged: buildSide(challengedSnapshot, p.challengedId),
  };
}

module.exports = {
  BATTLE_TIER_TO_COINS,
  WINNER_XP_BY_TIER,
  LOSER_XP_BY_TIER,
  createBattleChallenge,
  getBattleChallengeForUser,
  listBattleChallengesForUser,
  acceptBattleChallenge,
  declineOrCancelBattleChallenge,
  instantOpenBattle,
  buildBattleTeamsReveal,
};
