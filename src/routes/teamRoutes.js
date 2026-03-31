const path = require("path");
const fs = require("fs");
const { prisma } = require("../db/prisma");
const { requireUserToken } = require("../middlewares/auth");
const { upsertTeamRoster, calculateTeamOverallFromInstances } = require("../services/teamService");
const { mapInstanceRow } = require("../services/instanceApiMapper");
const {
  countTeamShields,
  parseShieldId,
  teamShieldPublicUrl,
} = require("../services/teamShieldService");
const { BATTLE_TIER_TO_COINS } = require("../services/battleService");

/** Fastify pode entregar o mesmo query param como string ou array (ex.: proxies / clientes). */
function firstQueryValue(val) {
  if (val === undefined || val === null) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

function parseBooleanQuery(val) {
  const v = firstQueryValue(val);
  if (v === undefined || v === null || v === "") return false;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  return ["true", "1", "yes", "on"].includes(s);
}

const TEAMS_LEADERBOARD_LOG_DIR =
  process.env.TEAMS_LEADERBOARD_LOG_DIR || path.join(__dirname, "..", "..", "logs");
const TEAMS_LEADERBOARD_LOG_FILE = path.join(TEAMS_LEADERBOARD_LOG_DIR, "teams-leaderboard-debug.log");

/** Após vitória contra um time, não listar o mesmo adversário em "abertos" por N h. Se a última batalha foi derrota, pode revanche (sem cooldown). */
const WIN_COOLDOWN_HOURS = (() => {
  const n = Number(process.env.TEAMS_LEADERBOARD_WIN_COOLDOWN_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 24;
})();
const WIN_VS_OPPONENT_COOLDOWN_MS = WIN_COOLDOWN_HOURS * 60 * 60 * 1000;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} viewerUserId
 * @param {Array<{ t: { userId: string } }>} rows
 */
async function filterHideRecentWinsAgainstOpponents(prisma, viewerUserId, rows) {
  if (!rows.length) return rows;
  const opponentIds = [
    ...new Set(rows.map((r) => r.t.userId).filter((id) => id && id !== viewerUserId)),
  ];
  if (opponentIds.length === 0) return rows;

  const latestByOpponent = new Map();
  await Promise.all(
    opponentIds.map(async (opp) => {
      const b = await prisma.battleChallenge.findFirst({
        where: {
          status: "RESOLVED",
          OR: [
            { challengerId: viewerUserId, challengedId: opp },
            { challengerId: opp, challengedId: viewerUserId },
          ],
        },
        orderBy: { resolvedAt: "desc" },
        select: { winnerId: true, resolvedAt: true },
      });
      if (b) latestByOpponent.set(opp, b);
    }),
  );

  const cutoff = Date.now() - WIN_VS_OPPONENT_COOLDOWN_MS;
  return rows.filter((row) => {
    const opp = row.t.userId;
    const last = latestByOpponent.get(opp);
    if (!last || !last.resolvedAt) return true;
    if (last.winnerId !== viewerUserId) return true;
    return last.resolvedAt.getTime() < cutoff;
  });
}

/** Log em arquivo para depuração de GET /teams/leaderboard. Desligar: TEAMS_LEADERBOARD_DEBUG_LOG=0 */
function logTeamsLeaderboardDebug(payload) {
  if (process.env.TEAMS_LEADERBOARD_DEBUG_LOG === "0") return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    logFile: TEAMS_LEADERBOARD_LOG_FILE,
    ...payload,
  });
  try {
    fs.mkdirSync(TEAMS_LEADERBOARD_LOG_DIR, { recursive: true });
    fs.appendFileSync(TEAMS_LEADERBOARD_LOG_FILE, `${line}\n`, "utf8");
  } catch (err) {
    console.error("[teams/leaderboard] debug log failed:", err?.message || err);
  }
}

async function getTeam(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  try {
    const team = await prisma.team.findUnique({
      where: { userId: String(userId) },
      select: {
        id: true,
        name: true,
        overall: true,
        shieldId: true,
        globalRank: true,
        wins: true,
        losses: true,
        openForBattle: true,
        openBattleStakeTier: true,
        openBattleMinBalance: true,
        createdAt: true,
        updatedAt: true,
        user: {
          select: {
            wallet: { select: { balance: true } },
          },
        },
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
                spawnSource: true,
                latitude: true,
                longitude: true,
                h3RoomCell: true,
                foundWhen: true,
                foundWhereCity: true,
                foundWhereState: true,
                foundWhereLat: true,
                foundWhereLng: true,
                spawnedAt: true,
                updatedAt: true,
                card: {
                  select: {
                    id: true,
                    name: true,
                    ovr: true,
                    url: true,
                    max_supply: true,
                    nation: true,
                    team: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!team) {
      return reply.code(404).send({ error: "Team not found" });
    }

    const rows = team.slots.map((s) => ({
      cardId: s.instance.cardId,
      card: {
        ovr: s.instance.card.ovr,
        nation: s.instance.card.nation,
      },
    }));
    const breakdown = calculateTeamOverallFromInstances(rows);

    const slots = team.slots.map((s) => ({
      slotIndex: s.slotIndex,
      instance: mapInstanceRow(s.instance),
    }));

    const stakeCoins =
      team.openForBattle && team.openBattleStakeTier
        ? BATTLE_TIER_TO_COINS[team.openBattleStakeTier] ?? null
        : null;
    const walletBalance = team.user?.wallet?.balance ?? 0;
    const minFloor = team.openBattleMinBalance;
    const aboveMinFloor = minFloor == null || walletBalance >= minFloor;
    const openBattleListed = Boolean(
      team.openForBattle &&
        team.openBattleStakeTier &&
        stakeCoins != null &&
        walletBalance >= stakeCoins &&
        aboveMinFloor,
    );

    return reply.send({
      id: team.id,
      name: team.name,
      overall: breakdown.overall,
      baseOverallSum: breakdown.baseSum,
      nationalityBonusPercent: breakdown.nationalityBonusPercent,
      maxSameNationCount: breakdown.maxSameNationCount,
      nationalitySynergy: breakdown.nationalitySynergy,
      shieldId: team.shieldId,
      shieldUrl: teamShieldPublicUrl(team.shieldId),
      globalRank: team.globalRank,
      wins: team.wins,
      losses: team.losses,
      openForBattle: team.openForBattle,
      openBattleStakeTier: team.openBattleStakeTier,
      openBattleStakeCoins: stakeCoins,
      openBattleMinBalance: team.openBattleMinBalance,
      walletBalance,
      openBattleListed,
      createdAt: team.createdAt.toISOString(),
      updatedAt: team.updatedAt.toISOString(),
      slots,
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to load team",
      message: err.message,
    });
  }
}

function resolveShieldIdForPatch(bodyShield) {
  if (bodyShield === undefined) return { skip: true };
  if (bodyShield === null || bodyShield === "") return { value: null };
  return { value: parseShieldId(bodyShield) };
}

async function patchTeam(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const hasName = body.name !== undefined;
  const hasInstances = body.instanceIds !== undefined && body.instanceIds !== null;
  const hasShield = body.shieldId !== undefined;

  if (!hasName && !hasInstances && !hasShield) {
    return reply.code(400).send({ error: "Provide name, instanceIds and/or shieldId" });
  }

  if (hasInstances) {
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds : [];
    if (instanceIds.length !== 5) {
      return reply.code(400).send({ error: "instanceIds must be an array of exactly 5 UUIDs" });
    }

    let shieldOpt;
    if (hasShield) {
      try {
        const r = resolveShieldIdForPatch(body.shieldId);
        shieldOpt = r.skip ? undefined : r.value;
      } catch (err) {
        return mapShieldError(reply, err);
      }
    }

    try {
      await prisma.$transaction(async (tx) => {
        await upsertTeamRoster(tx, userId, instanceIds, {
          name: hasName ? body.name : undefined,
          shieldId: hasShield ? shieldOpt : undefined,
        });
      });
    } catch (err) {
      const code = err?.code;
      if (code === "TEAM_REQUIRES_FIVE_INSTANCES" || code === "TEAM_REQUIRES_FIVE_CARDS") {
        return reply.code(400).send({ error: "Exactly 5 instances are required" });
      }
      if (code === "TEAM_INSTANCES_NOT_OWNED" || code === "TEAM_INSTANCES_INVALID") {
        return reply.code(400).send({ error: "All instances must belong to you" });
      }
      if (code === "TEAM_DUPLICATE_PLAYER") {
        return reply.code(400).send({ error: "The same player cannot appear twice in the team" });
      }
      if (code === "TEAM_DUPLICATE_INSTANCE_SLOT") {
        return reply.code(400).send({ error: "Duplicate instance id in instanceIds" });
      }
      if (
        code === "TEAM_SHIELD_ID_INVALID" ||
        code === "TEAM_SHIELDS_UNAVAILABLE" ||
        code === "TEAM_SHIELD_ID_OUT_OF_RANGE"
      ) {
        return mapShieldError(reply, err);
      }
      request.log?.error?.(err);
      return reply.code(500).send({ error: "Failed to update team", message: err.message });
    }
  } else {
    const data = {};
    if (hasName) {
      const name = String(body.name).trim();
      if (!name) {
        return reply.code(400).send({ error: "name cannot be empty" });
      }
      data.name = name;
    }
    if (hasShield) {
      try {
        const r = resolveShieldIdForPatch(body.shieldId);
        if (!r.skip) data.shieldId = r.value;
      } catch (err) {
        return mapShieldError(reply, err);
      }
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: "Provide name and/or shieldId" });
    }
    try {
      const updated = await prisma.team.updateMany({
        where: { userId: String(userId) },
        data,
      });
      if (updated.count === 0) {
        return reply.code(404).send({ error: "Team not found" });
      }
    } catch (err) {
      request.log?.error?.(err);
      return reply.code(500).send({ error: "Failed to update team", message: err.message });
    }
  }

  return getTeam(request, reply);
}

function mapShieldError(reply, err) {
  const code = err?.code;
  if (code === "TEAM_SHIELD_ID_INVALID") {
    return reply.code(400).send({ error: "shieldId must be a positive integer, null, or omitted" });
  }
  if (code === "TEAM_SHIELDS_UNAVAILABLE") {
    return reply.code(400).send({ error: "No team shields available on server" });
  }
  if (code === "TEAM_SHIELD_ID_OUT_OF_RANGE") {
    return reply.code(400).send({
      error: "shieldId out of range",
      max: err.max,
    });
  }
  return reply.code(500).send({ error: "Failed to validate shield", message: err?.message });
}

async function getTeamShields(request, reply) {
  try {
    return reply.send({ count: countTeamShields() });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list team shields",
      message: err.message,
    });
  }
}

async function patchTeamBattleSettings(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const hasOpen = body.openForBattle !== undefined;
  const hasTier = body.stakeTier !== undefined;
  const hasMinBalance = body.openBattleMinBalance !== undefined;

  if (!hasOpen && !hasTier && !hasMinBalance) {
    return reply.code(400).send({ error: "Provide openForBattle, stakeTier, and/or openBattleMinBalance" });
  }

  let openForBattleUpdate;
  if (hasOpen) {
    openForBattleUpdate = Boolean(body.openForBattle);
  }

  let stakeTierUpdate;
  if (hasTier) {
    if (body.stakeTier === null || body.stakeTier === "") {
      stakeTierUpdate = null;
    } else {
      const raw = String(body.stakeTier).trim().toUpperCase();
      if (!Object.prototype.hasOwnProperty.call(BATTLE_TIER_TO_COINS, raw)) {
        return reply.code(400).send({
          error: "stakeTier must be one of: COINS_10, COINS_50, COINS_100, COINS_1000 or null",
        });
      }
      stakeTierUpdate = raw;
    }
  }

  if (openForBattleUpdate === true && !hasTier) {
    return reply
      .code(400)
      .send({ error: "When enabling openForBattle, stakeTier is required in the same request" });
  }

  let minBalanceUpdate;
  if (hasMinBalance) {
    if (body.openBattleMinBalance === null || body.openBattleMinBalance === "") {
      minBalanceUpdate = null;
    } else {
      const n = Number(body.openBattleMinBalance);
      if (!Number.isInteger(n) || n < 0) {
        return reply.code(400).send({
          error: "openBattleMinBalance must be a non-negative integer or null",
        });
      }
      minBalanceUpdate = n;
    }
  }

  try {
    const data = {};
    if (hasOpen) data.openForBattle = openForBattleUpdate;
    if (hasTier) data.openBattleStakeTier = stakeTierUpdate;
    if (hasMinBalance) data.openBattleMinBalance = minBalanceUpdate;

    const updated = await prisma.team.updateMany({
      where: { userId: String(userId) },
      data,
    });
    if (updated.count === 0) {
      return reply.code(404).send({ error: "Team not found" });
    }
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to update team battle settings",
      message: err.message,
    });
  }

  return getTeam(request, reply);
}

async function getTeamsLeaderboard(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const q = request.query || {};
  const take = Math.min(Math.max(Number(firstQueryValue(q.take)) || 50, 1), 100);
  const skip = Math.max(Number(firstQueryValue(q.skip)) || 0, 0);
  const minOverallRaw = firstQueryValue(q.minOverall);
  const maxOverallRaw = firstQueryValue(q.maxOverall);
  const minOverall =
    minOverallRaw !== undefined && minOverallRaw !== null && minOverallRaw !== ""
      ? Number(minOverallRaw)
      : undefined;
  const maxOverall =
    maxOverallRaw !== undefined && maxOverallRaw !== null && maxOverallRaw !== ""
      ? Number(maxOverallRaw)
      : undefined;
  const onlyOpen = parseBooleanQuery(
    firstQueryValue(q.onlyOpenForBattle) ?? firstQueryValue(q.onlyOpen) ?? firstQueryValue(q.openForBattle),
  );

  const where = {};
  if (Number.isFinite(minOverall) || Number.isFinite(maxOverall)) {
    where.overall = {};
    if (Number.isFinite(minOverall)) where.overall.gte = minOverall;
    if (Number.isFinite(maxOverall)) where.overall.lte = maxOverall;
  }
  if (onlyOpen) {
    where.openForBattle = true;
    where.openBattleStakeTier = { not: null };
  }

  try {
    const [items, total] = await prisma.$transaction([
      prisma.team.findMany({
        where,
        orderBy: [
          { wins: "desc" },
          { overall: "desc" },
          { createdAt: "asc" },
        ],
        select: {
          id: true,
          name: true,
          overall: true,
          wins: true,
          losses: true,
          shieldId: true,
          openForBattle: true,
          openBattleStakeTier: true,
          openBattleMinBalance: true,
          userId: true,
          user: {
            select: {
              id: true,
              username: true,
              avatarId: true,
              wallet: {
                select: { balance: true },
              },
            },
          },
        },
      }),
      prisma.team.count({ where }),
    ]);

    logTeamsLeaderboardDebug({
      event: "teams_leaderboard_after_prisma",
      authUserId: userId,
      rawQuery: q,
      parsed: {
        onlyOpenForBattle: onlyOpen,
        take,
        skip,
        minOverall,
        maxOverall,
        where,
      },
      prismaCount: total,
      prismaItemsLength: items.length,
      rows: items.map((t) => ({
        teamId: t.id,
        userId: t.userId,
        openForBattle: t.openForBattle,
        openBattleStakeTier: t.openBattleStakeTier,
        hasUser: Boolean(t.user),
        userIdFromUser: t.user?.id,
        walletBalance: t.user?.wallet?.balance,
        walletPresent: t.user?.wallet != null,
      })),
    });

    const scored = items.map((t) => {
      if (!t.user) {
        return { t, eligible: false, stakeCoins: 0, balance: 0, missingUser: true };
      }
      if (!t.openForBattle || !t.openBattleStakeTier) {
        return { t, eligible: !onlyOpen, stakeCoins: 0, balance: Number(t.user?.wallet?.balance ?? 0) };
      }
      const stakeCoins = BATTLE_TIER_TO_COINS[t.openBattleStakeTier] || 0;
      const balance = Number(t.user?.wallet?.balance ?? 0);
      const minFloor = t.openBattleMinBalance;
      const aboveMinFloor = minFloor == null || balance >= minFloor;
      const eligible =
        !(stakeCoins > 0 && balance < stakeCoins) && aboveMinFloor;
      return { t, eligible, stakeCoins, balance };
    });

    const filtered = scored.filter((row) => {
      if (row.missingUser) return false;
      if (!onlyOpen) {
        if (!row.t.openForBattle || !row.t.openBattleStakeTier) return true;
        return row.eligible;
      }
      return row.t.openForBattle && row.t.openBattleStakeTier && row.eligible;
    });

    let filteredForResponse = filtered;
    if (onlyOpen) {
      filteredForResponse = await filterHideRecentWinsAgainstOpponents(prisma, userId, filtered);
    }

    logTeamsLeaderboardDebug({
      event: "teams_leaderboard_after_filter",
      authUserId: userId,
      scored: scored.map((row) => ({
        teamId: row.t.id,
        userId: row.t.userId,
        missingUser: Boolean(row.missingUser),
        openForBattle: row.t.openForBattle,
        tier: row.t.openBattleStakeTier,
        stakeCoins: row.stakeCoins,
        balance: row.balance,
        eligible: row.eligible,
      })),
      filteredLength: filtered.length,
      filteredAfterWinCooldown: onlyOpen ? filteredForResponse.length : undefined,
      onlyOpen,
    });

    const sliced = filteredForResponse.slice(skip, skip + take);

    const mapped = sliced.map((row) => {
      const t = row.t;
      const requiredStakeCoins =
        t.openForBattle && t.openBattleStakeTier
          ? BATTLE_TIER_TO_COINS[t.openBattleStakeTier] || null
          : null;
      const base = {
        teamId: t.id,
        name: t.name,
        overall: t.overall,
        wins: t.wins,
        losses: t.losses,
        shieldId: t.shieldId,
        shieldUrl: teamShieldPublicUrl(t.shieldId),
        user: {
          id: t.user.id,
          username: t.user.username,
          avatarId: t.user.avatarId,
        },
        openForBattle: t.openForBattle,
        openBattleStakeTier: t.openBattleStakeTier,
        openBattleStakeCoins: requiredStakeCoins,
      };
      return base;
    });

    const responseBody = {
      items: mapped,
      total: filteredForResponse.length,
      take,
      skip,
      meta: {
        onlyOpenForBattle: onlyOpen,
        rawRowsFromDb: items.length,
        winCooldownHours: onlyOpen ? WIN_COOLDOWN_HOURS : undefined,
        debugLogFile: TEAMS_LEADERBOARD_LOG_FILE,
      },
    };

    logTeamsLeaderboardDebug({
      event: "teams_leaderboard_response",
      authUserId: userId,
      returnedItemCount: mapped.length,
      listTotal: filteredForResponse.length,
    });

    return reply.send(responseBody);
  } catch (err) {
    logTeamsLeaderboardDebug({
      event: "teams_leaderboard_error",
      authUserId: userId,
      error: err?.message,
      stack: err?.stack,
    });
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list teams leaderboard",
      message: err.message,
    });
  }
}

async function teamRoutes(fastify) {
  fastify.get("/team-shields", getTeamShields);
  fastify.get("/user/team", { preHandler: requireUserToken }, getTeam);
  fastify.patch("/user/team", { preHandler: requireUserToken }, patchTeam);
  fastify.patch("/user/team/battle-settings", { preHandler: requireUserToken }, patchTeamBattleSettings);
  fastify.get("/teams/leaderboard", { preHandler: requireUserToken }, getTeamsLeaderboard);
}

module.exports = teamRoutes;
