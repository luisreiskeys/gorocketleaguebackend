const { pickRandomShieldId, parseShieldId } = require("./teamShieldService");

/**
 * Overall do time: soma dos OVR das 5 instâncias + bônus de nacionalidade (campo `nation` do Player).
 *
 * Para cada nacionalidade distinta, aplica-se a tabela abaixo ao **tamanho do grupo** daquela nação.
 * Os percentuais **somam** entre nações (ex.: 2 canadenses +5% e 2 alemães +5% ⇒ +10% no total).
 *
 * Tabela por grupo: 2→+5%, 3→+10%, 4→+30%, 5→+80%.
 * Instâncias com mesmo jogador (mesmo cardId) não podem estar no time ao mesmo tempo.
 */

function nationKey(nation) {
  if (nation === null || nation === undefined) return null;
  const s = String(nation).trim();
  return s.length ? s.toLowerCase() : null;
}

function nationalityBonusForGroupSize(groupSize) {
  if (groupSize >= 5) return 80;
  if (groupSize === 4) return 30;
  if (groupSize === 3) return 10;
  if (groupSize === 2) return 5;
  return 0;
}

/**
 * @param {Array<{ ovr: number | null, nation: string | null }>} cards
 * @returns {{ overall: number, baseSum: number, nationalityBonusPercent: number, maxSameNationCount: number, nationalitySynergy: Array<{ nation: string, count: number, bonusPercent: number }> }}
 */
function calculateTeamOverallFromCards(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) {
    throw Object.assign(new Error("TEAM_REQUIRES_FIVE_CARDS"), { code: "TEAM_REQUIRES_FIVE_CARDS" });
  }

  const baseSum = cards.reduce((sum, c) => {
    const ovr = c?.ovr;
    return sum + (Number.isFinite(Number(ovr)) ? Number(ovr) : 0);
  }, 0);

  const counts = new Map();
  const labelByKey = new Map();

  for (const c of cards) {
    const key = nationKey(c?.nation);
    if (key === null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!labelByKey.has(key)) {
      labelByKey.set(key, String(c.nation).trim() || key);
    }
  }

  let maxSameNationCount = 0;
  let totalPct = 0;
  /** @type {Array<{ nation: string, count: number, bonusPercent: number }>} */
  const nationalitySynergy = [];

  for (const [key, count] of counts.entries()) {
    if (count > maxSameNationCount) maxSameNationCount = count;
    const b = nationalityBonusForGroupSize(count);
    totalPct += b;
    if (b > 0) {
      nationalitySynergy.push({
        nation: labelByKey.get(key) ?? key,
        count,
        bonusPercent: b,
      });
    }
  }

  const overall = Math.round(baseSum * (1 + totalPct / 100));

  return {
    overall,
    baseSum,
    nationalityBonusPercent: totalPct,
    maxSameNationCount,
    nationalitySynergy,
  };
}

/**
 * @param {Array<{ cardId: number, card: { ovr: number | null, nation: string | null } }>} rows
 */
function calculateTeamOverallFromInstances(rows) {
  const cards = rows.map((r) => ({
    ovr: r.card?.ovr ?? null,
    nation: r.card?.nation ?? null,
  }));
  return calculateTeamOverallFromCards(cards);
}

function assertDistinctCardIds(rows) {
  const seen = new Set();
  for (const r of rows) {
    const id = Number(r.cardId);
    if (seen.has(id)) {
      throw Object.assign(new Error("TEAM_DUPLICATE_PLAYER"), {
        code: "TEAM_DUPLICATE_PLAYER",
        cardId: id,
      });
    }
    seen.add(id);
  }
}

/**
 * Cria o time inicial com 5 instâncias (ex.: após o first pack). Transação externa.
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} userId
 * @param {Array<{ id: string }>} instances
 */
async function createInitialTeam(tx, userId, instances) {
  if (!instances || instances.length !== 5) {
    throw Object.assign(new Error("TEAM_REQUIRES_FIVE_INSTANCES"), { code: "TEAM_REQUIRES_FIVE_INSTANCES" });
  }

  const existing = await tx.team.findUnique({
    where: { userId: String(userId) },
    select: { id: true },
  });
  if (existing) {
    return existing;
  }

  const ids = instances.map((i) => String(i.id));
  const rows = await tx.instance.findMany({
    where: {
      id: { in: ids },
      ownerId: String(userId),
    },
    select: {
      id: true,
      cardId: true,
      card: { select: { ovr: true, nation: true } },
    },
  });

  if (rows.length !== 5) {
    throw Object.assign(new Error("TEAM_INSTANCES_NOT_OWNED"), { code: "TEAM_INSTANCES_NOT_OWNED" });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== 5) {
    throw Object.assign(new Error("TEAM_INSTANCES_INVALID"), { code: "TEAM_INSTANCES_INVALID" });
  }

  assertDistinctCardIds(ordered);
  const { overall } = calculateTeamOverallFromInstances(ordered);

  const team = await tx.team.create({
    data: {
      userId: String(userId),
      name: "Meu Time",
      overall,
      shieldId: pickRandomShieldId(),
      slots: {
        create: ordered.map((row, slotIndex) => ({
          slotIndex,
          instanceId: row.id,
        })),
      },
    },
    select: { id: true, userId: true, name: true, overall: true },
  });

  return team;
}

/**
 * Substitui as 5 posições do time (ou cria o time se ainda não existir).
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} userId
 * @param {string[]} instanceIds ordem = slots 0..4
 * @param {{ name?: string, shieldId?: number | null }} [options]
 */
async function upsertTeamRoster(tx, userId, instanceIds, options) {
  const name = options?.name;
  const shieldIdOpt = options?.shieldId;
  if (!Array.isArray(instanceIds) || instanceIds.length !== 5) {
    throw Object.assign(new Error("TEAM_REQUIRES_FIVE_INSTANCES"), { code: "TEAM_REQUIRES_FIVE_INSTANCES" });
  }

  const ids = instanceIds.map((id) => String(id));
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== 5) {
    throw Object.assign(new Error("TEAM_DUPLICATE_INSTANCE_SLOT"), { code: "TEAM_DUPLICATE_INSTANCE_SLOT" });
  }

  const rows = await tx.instance.findMany({
    where: {
      id: { in: ids },
      ownerId: String(userId),
    },
    select: {
      id: true,
      cardId: true,
      card: { select: { ovr: true, nation: true } },
    },
  });

  if (rows.length !== 5) {
    throw Object.assign(new Error("TEAM_INSTANCES_NOT_OWNED"), { code: "TEAM_INSTANCES_NOT_OWNED" });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
  if (ordered.length !== 5) {
    throw Object.assign(new Error("TEAM_INSTANCES_INVALID"), { code: "TEAM_INSTANCES_INVALID" });
  }

  assertDistinctCardIds(ordered);
  const stats = calculateTeamOverallFromInstances(ordered);

  let team = await tx.team.findUnique({
    where: { userId: String(userId) },
    select: { id: true },
  });

  if (!team) {
    let shieldIdForCreate;
    if (shieldIdOpt !== undefined) {
      shieldIdForCreate = shieldIdOpt === null ? null : parseShieldId(shieldIdOpt);
    } else {
      shieldIdForCreate = pickRandomShieldId();
    }
    team = await tx.team.create({
      data: {
        userId: String(userId),
        name: name && String(name).trim() ? String(name).trim() : "Meu Time",
        overall: stats.overall,
        shieldId: shieldIdForCreate,
        slots: {
          create: ordered.map((row, slotIndex) => ({
            slotIndex,
            instanceId: row.id,
          })),
        },
      },
      select: { id: true },
    });
  } else {
    await tx.teamSlot.deleteMany({ where: { teamId: team.id } });
    const data = {
      overall: stats.overall,
      slots: {
        create: ordered.map((row, slotIndex) => ({
          slotIndex,
          instanceId: row.id,
        })),
      },
    };
    if (name !== undefined) {
      data.name = String(name).trim() || "Meu Time";
    }
    if (shieldIdOpt !== undefined) {
      data.shieldId = shieldIdOpt === null ? null : parseShieldId(shieldIdOpt);
    }
    await tx.team.update({
      where: { id: team.id },
      data,
    });
  }

  return { teamId: team.id, ...stats };
}

/**
 * Atualiza vitória/derrota após uma partida (chamar dentro da mesma transação da partida).
 * `globalRank` continua a cargo de um job de ranking quando existir.
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} teamId
 * @param {"win" | "loss"} result
 */
async function recordTeamMatchResult(tx, teamId, result) {
  const id = String(teamId);
  if (result === "win") {
    return tx.team.update({
      where: { id },
      data: { wins: { increment: 1 } },
      select: { id: true, wins: true, losses: true },
    });
  }
  if (result === "loss") {
    return tx.team.update({
      where: { id },
      data: { losses: { increment: 1 } },
      select: { id: true, wins: true, losses: true },
    });
  }
  throw Object.assign(new Error("INVALID_MATCH_RESULT"), { code: "INVALID_MATCH_RESULT" });
}

/**
 * Atualiza o rank global em lote (ex.: cron após partidas).
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {Array<{ teamId: string, globalRank: number }>} ranks 1-based
 */
async function setTeamsGlobalRanks(tx, ranks) {
  for (const row of ranks) {
    await tx.team.update({
      where: { id: String(row.teamId) },
      data: { globalRank: row.globalRank },
    });
  }
}

/**
 * Se o time está aberto para batalha e há piso de saldo configurado, desliga a listagem
 * quando o saldo ficar estritamente abaixo desse piso (chamar dentro da mesma transação após débitos).
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} userId
 */
async function applyOpenBattleAutoDisableIfNeeded(tx, userId) {
  const uid = String(userId);
  const team = await tx.team.findUnique({
    where: { userId: uid },
    select: { id: true, openForBattle: true, openBattleMinBalance: true },
  });
  if (!team?.openForBattle || team.openBattleMinBalance == null) {
    return { disabled: false };
  }
  const wallet = await tx.wallet.findUnique({
    where: { userId: uid },
    select: { balance: true },
  });
  const balance = wallet?.balance ?? 0;
  if (balance >= team.openBattleMinBalance) {
    return { disabled: false };
  }
  await tx.team.update({
    where: { id: team.id },
    data: {
      openForBattle: false,
      openBattleStakeTier: null,
    },
  });
  return { disabled: true };
}

module.exports = {
  calculateTeamOverallFromCards,
  calculateTeamOverallFromInstances,
  nationalityBonusForGroupSize,
  createInitialTeam,
  upsertTeamRoster,
  recordTeamMatchResult,
  setTeamsGlobalRanks,
  applyOpenBattleAutoDisableIfNeeded,
};
