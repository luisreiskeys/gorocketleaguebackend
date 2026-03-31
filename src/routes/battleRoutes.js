const { prisma } = require("../db/prisma");
const { requireUserToken } = require("../middlewares/auth");
const { getWalletBalance } = require("../services/coinService");
const {
  BATTLE_TIER_TO_COINS,
  createBattleChallenge,
  getBattleChallengeForUser,
  listBattleChallengesForUser,
  acceptBattleChallenge,
  declineOrCancelBattleChallenge,
  instantOpenBattle,
  buildBattleTeamsReveal,
} = require("../services/battleService");

function mapChallenge(challenge) {
  if (!challenge) return null;
  return {
    id: challenge.id,
    status: challenge.status,
    stakeTier: challenge.stakeTier,
    stakeCoins: challenge.stakeCoins,
    challenger: challenge.challenger,
    challenged: challenge.challenged,
    winner: challenge.winner || null,
    loser: challenge.loser || null,
    challengerSnapshot: challenge.challengerSnapshot,
    challengedSnapshot: challenge.challengedSnapshot,
    rewardCardInstance: challenge.rewardCardInstance || null,
    expiresAt: challenge.expiresAt.toISOString(),
    acceptedAt: challenge.acceptedAt ? challenge.acceptedAt.toISOString() : null,
    resolvedAt: challenge.resolvedAt ? challenge.resolvedAt.toISOString() : null,
    createdAt: challenge.createdAt.toISOString(),
    updatedAt: challenge.updatedAt.toISOString(),
  };
}

function battleErrorReply(reply, err) {
  const code = err?.code;
  const map = {
    BATTLE_INVALID_TIER: [400, err.message],
    BATTLE_SELF: [400, err.message],
    BATTLE_USER_NOT_FOUND: [404, err.message],
    BATTLE_TEAM_NOT_READY: [400, err.message],
    BATTLE_INSUFFICIENT_COINS: [400, err.message],
    BATTLE_NOT_FOUND: [404, err.message],
    BATTLE_EXPIRED: [409, err.message],
    BATTLE_OPEN_NOT_AVAILABLE: [409, err.message],
    BATTLE_TIER_MISMATCH: [400, err.message],
    BATTLE_OPPONENT_INSUFFICIENT_COINS: [409, err.message],
    BATTLE_SNAPSHOT_INVALID: [500, err.message],
    BATTLE_INSTANCE_NOT_FOUND: [500, err.message],
  };
  const [status, msg] = map[code] || [500, err?.message || "Battle error"];
  if (status === 500) {
    return reply.code(500).send({ error: "Failed battle operation", message: msg });
  }
  return reply.code(status).send({ error: msg, code });
}

/**
 * Duelo imediato contra time com "aberto para batalha" (sem convite/aceite).
 * POST /battles/instant-open
 */
async function postInstantOpen(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const body = request.body || {};
  const opponentUserId = body.opponentUserId ?? body.challengedId;
  const stakeTier = body.stakeTier;
  if (!opponentUserId || typeof opponentUserId !== "string") {
    return reply.code(400).send({ error: "opponentUserId (or challengedId) is required" });
  }
  try {
    const summary = await instantOpenBattle(prisma, {
      challengerId: userId,
      challengedId: opponentUserId,
      stakeTier: stakeTier ?? null,
    });
    const challenge = await getBattleChallengeForUser(prisma, summary.battleId, userId);
    const teams = await buildBattleTeamsReveal(prisma, {
      challengerSnapshot: challenge.challengerSnapshot,
      challengedSnapshot: challenge.challengedSnapshot,
      challengerId: challenge.challengerId,
      challengedId: challenge.challengedId,
    });
    const balanceAfter = await getWalletBalance(userId);
    const youWon = challenge.winnerId === userId;
    const xpGained = youWon ? summary.winnerXp : summary.loserXp;
    return reply.code(201).send({
      battle: mapChallenge(challenge),
      teams,
      viewerRole: "challenger",
      self: {
        result: youWon ? "win" : "loss",
        xpGained,
        walletBalanceAfter: balanceAfter,
      },
      summary: {
        pot: summary.pot,
        stakeCoins: summary.stakeCoins,
        stakeTier: summary.stakeTier,
        winnerUserId: summary.winnerUserId,
        loserUserId: summary.loserUserId,
      },
    });
  } catch (err) {
    if (err?.code) return battleErrorReply(reply, err);
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to start instant battle", message: err.message });
  }
}

async function postBattle(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const body = request.body || {};
  const challengedId = body.challengedId ?? body.counterpartyId;
  const stakeTier = body.stakeTier;
  if (!challengedId || typeof challengedId !== "string") {
    return reply.code(400).send({ error: "challengedId is required" });
  }
  if (!stakeTier || typeof stakeTier !== "string") {
    return reply.code(400).send({ error: "stakeTier is required" });
  }
  try {
    const id = await createBattleChallenge(prisma, {
      challengerId: userId,
      challengedId,
      stakeTier,
    });
    const challenge = await getBattleChallengeForUser(prisma, id, userId);
    return reply.code(201).send(mapChallenge(challenge));
  } catch (err) {
    if (err?.code) return battleErrorReply(reply, err);
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to create battle", message: err.message });
  }
}

async function getBattleById(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  try {
    const challenge = await getBattleChallengeForUser(prisma, request.params?.id, userId);
    if (!challenge) return reply.code(404).send({ error: "Battle challenge not found" });
    return reply.send(mapChallenge(challenge));
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to load battle", message: err.message });
  }
}

async function getBattlesList(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  const q = request.query || {};
  const role = q.role;
  if (role && role !== "challenger" && role !== "challenged" && role !== "all") {
    return reply.code(400).send({ error: "role must be challenger, challenged, or all" });
  }
  const allowedStatuses = ["PENDING", "RESOLVED", "DECLINED", "CANCELLED", "EXPIRED"];
  const status = q.status;
  if (status && !allowedStatuses.includes(String(status))) {
    return reply.code(400).send({ error: `status must be one of: ${allowedStatuses.join(", ")}` });
  }
  try {
    const result = await listBattleChallengesForUser(prisma, {
      userId,
      role: role || "all",
      status: status || undefined,
      take: q.take,
      skip: q.skip,
    });
    return reply.send({
      items: result.items.map(mapChallenge),
      total: result.total,
      take: result.take,
      skip: result.skip,
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to list battles", message: err.message });
  }
}

async function postAccept(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  try {
    await acceptBattleChallenge(prisma, request.params?.id, userId);
    const challenge = await getBattleChallengeForUser(prisma, request.params?.id, userId);
    return reply.send(mapChallenge(challenge));
  } catch (err) {
    if (err?.code) return battleErrorReply(reply, err);
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to accept battle", message: err.message });
  }
}

async function postDecline(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  try {
    await declineOrCancelBattleChallenge(prisma, request.params?.id, userId, "decline");
    const challenge = await getBattleChallengeForUser(prisma, request.params?.id, userId);
    return reply.send(mapChallenge(challenge));
  } catch (err) {
    if (err?.code) return battleErrorReply(reply, err);
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to decline battle", message: err.message });
  }
}

async function deleteBattle(request, reply) {
  const userId = request.user?.sub;
  if (!userId) return reply.code(401).send({ error: "Unauthorized" });
  try {
    await declineOrCancelBattleChallenge(prisma, request.params?.id, userId, "cancel");
    const challenge = await getBattleChallengeForUser(prisma, request.params?.id, userId);
    return reply.send(mapChallenge(challenge));
  } catch (err) {
    if (err?.code) return battleErrorReply(reply, err);
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to cancel battle", message: err.message });
  }
}

async function getBattleTiers(_request, reply) {
  return reply.send({
    tiers: Object.entries(BATTLE_TIER_TO_COINS).map(([tier, coins]) => ({ tier, coins })),
  });
}

async function battleRoutes(fastify) {
  fastify.get("/battle-tiers", getBattleTiers);
  fastify.post("/battles/instant-open", { preHandler: requireUserToken }, postInstantOpen);
  fastify.post("/battles", { preHandler: requireUserToken }, postBattle);
  fastify.get("/battles", { preHandler: requireUserToken }, getBattlesList);
  fastify.get("/battles/:id", { preHandler: requireUserToken }, getBattleById);
  fastify.post("/battles/:id/accept", { preHandler: requireUserToken }, postAccept);
  fastify.post("/battles/:id/decline", { preHandler: requireUserToken }, postDecline);
  fastify.delete("/battles/:id", { preHandler: requireUserToken }, deleteBattle);
}

module.exports = battleRoutes;
