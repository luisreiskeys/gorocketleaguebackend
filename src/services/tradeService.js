/**
 * Trocas de instâncias entre usuários (propostas N↔M).
 * Instâncias no time (TeamSlot) não podem ser incluídas até serem removidas do elenco.
 */

function err(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function normalizeIds(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((id) => String(id).trim()).filter(Boolean))];
}

const instanceSelect = {
  id: true,
  ownerId: true,
  cardId: true,
  serialNumber: true,
  serialMax: true,
  latitude: true,
  longitude: true,
  h3RoomCell: true,
  spawnSource: true,
  foundWhen: true,
  foundWhereCity: true,
  foundWhereState: true,
  foundWhereLat: true,
  foundWhereLng: true,
  spawnedAt: true,
  updatedAt: true,
  teamSlot: { select: { id: true } },
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
};

/**
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string[]} instanceIds
 */
async function assertInstancesNotInTeam(tx, instanceIds) {
  if (!instanceIds.length) return;
  const rows = await tx.instance.findMany({
    where: {
      id: { in: instanceIds },
      teamSlot: { isNot: null },
    },
    select: { id: true },
  });
  if (rows.length) {
    throw err("TRADE_INSTANCE_IN_TEAM", "Remove instances from your team before trading", {
      instanceIds: rows.map((r) => r.id),
    });
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{
 *   initiatorId: string,
 *   counterpartyId: string,
 *   offerInstanceIds: string[],
 *   requestInstanceIds: string[],
 * }} params
 */
async function createTradeProposal(prisma, params) {
  const initiatorId = String(params.initiatorId);
  const counterpartyId = String(params.counterpartyId);
  const offerInstanceIds = normalizeIds(params.offerInstanceIds);
  const requestInstanceIds = normalizeIds(params.requestInstanceIds);

  if (initiatorId === counterpartyId) {
    throw err("TRADE_SELF", "Cannot trade with yourself");
  }

  if (!offerInstanceIds.length || !requestInstanceIds.length) {
    throw err("TRADE_EMPTY_SIDE", "Both offer and request must include at least one instance");
  }

  const allIds = [...offerInstanceIds, ...requestInstanceIds];
  if (allIds.length !== new Set(allIds).size) {
    throw err("TRADE_DUPLICATE_INSTANCE", "Duplicate instance id across offer and request");
  }

  const counterparty = await prisma.user.findUnique({
    where: { id: counterpartyId },
    select: { id: true },
  });
  if (!counterparty) {
    throw err("TRADE_USER_NOT_FOUND", "Counterparty user not found");
  }

  return prisma.$transaction(async (tx) => {
    const offerRows = await tx.instance.findMany({
      where: { id: { in: offerInstanceIds }, ownerId: initiatorId },
      select: { id: true },
    });
    if (offerRows.length !== offerInstanceIds.length) {
      throw err("TRADE_INSTANCE_NOT_OWNED", "All offered instances must belong to you");
    }

    const requestRows = await tx.instance.findMany({
      where: { id: { in: requestInstanceIds }, ownerId: counterpartyId },
      select: { id: true },
    });
    if (requestRows.length !== requestInstanceIds.length) {
      throw err("TRADE_INSTANCE_NOT_OWNED", "All requested instances must belong to the counterparty");
    }

    // Regra de criação: apenas o proponente não pode oferecer titular.
    // O lado solicitado pode estar no time; isso será validado no momento do aceite.
    await assertInstancesNotInTeam(tx, offerInstanceIds);

    const proposal = await tx.tradeProposal.create({
      data: {
        initiatorId,
        counterpartyId,
        items: {
          create: [
            ...offerInstanceIds.map((instanceId) => ({
              instanceId,
              side: "FROM_INITIATOR",
            })),
            ...requestInstanceIds.map((instanceId) => ({
              instanceId,
              side: "FROM_COUNTERPARTY",
            })),
          ],
        },
      },
      select: { id: true },
    });

    return proposal.id;
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} proposalId
 * @param {string} userId
 */
async function getTradeProposalForUser(prisma, proposalId, userId) {
  const uid = String(userId);
  const proposal = await prisma.tradeProposal.findFirst({
    where: {
      id: String(proposalId),
      OR: [{ initiatorId: uid }, { counterpartyId: uid }],
    },
    include: {
      initiator: { select: { id: true, username: true } },
      counterparty: { select: { id: true, username: true } },
      items: {
        include: {
          instance: { select: instanceSelect },
        },
      },
    },
  });
  return proposal;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ userId: string, role?: 'initiator'|'counterparty'|'all', status?: import('@prisma/client').TradeProposalStatus, take?: number, skip?: number }} q
 */
async function listTradeProposalsForUser(prisma, q) {
  const uid = String(q.userId);
  const role = q.role || "all";
  const take = Math.min(Math.max(Number(q.take) || 50, 1), 100);
  const skip = Math.max(Number(q.skip) || 0, 0);

  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(role === "initiator"
      ? { initiatorId: uid }
      : role === "counterparty"
        ? { counterpartyId: uid }
        : { OR: [{ initiatorId: uid }, { counterpartyId: uid }] }),
  };

  const [items, total] = await prisma.$transaction([
    prisma.tradeProposal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        initiator: { select: { id: true, username: true } },
        counterparty: { select: { id: true, username: true } },
        items: {
          include: {
            instance: { select: instanceSelect },
          },
        },
      },
    }),
    prisma.tradeProposal.count({ where }),
  ]);

  return { items, total, take, skip };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} proposalId
 * @param {string} counterpartyId
 */
async function acceptTradeProposal(prisma, proposalId, counterpartyId) {
  const cid = String(counterpartyId);
  const pid = String(proposalId);

  return prisma.$transaction(async (tx) => {
    const proposal = await tx.tradeProposal.findFirst({
      where: { id: pid, counterpartyId: cid, status: "PENDING" },
      include: {
        items: { select: { instanceId: true, side: true } },
      },
    });

    if (!proposal) {
      throw err("TRADE_NOT_FOUND", "Trade proposal not found or not pending for you");
    }

    const initiatorIds = proposal.items.filter((i) => i.side === "FROM_INITIATOR").map((i) => i.instanceId);
    const counterpartyIds = proposal.items.filter((i) => i.side === "FROM_COUNTERPARTY").map((i) => i.instanceId);
    const allIds = [...initiatorIds, ...counterpartyIds];

    const instances = await tx.instance.findMany({
      where: { id: { in: allIds } },
      select: {
        id: true,
        ownerId: true,
        teamSlot: { select: { id: true } },
      },
    });

    const byId = new Map(instances.map((r) => [r.id, r]));

    for (const id of initiatorIds) {
      const row = byId.get(id);
      if (!row || row.ownerId !== proposal.initiatorId) {
        throw err("TRADE_OWNERSHIP_CHANGED", "Offered instances are no longer owned by the initiator");
      }
      if (row.teamSlot) {
        throw err("TRADE_INSTANCE_IN_TEAM", "Initiator has an instance in the team; trade blocked");
      }
    }
    for (const id of counterpartyIds) {
      const row = byId.get(id);
      if (!row || row.ownerId !== proposal.counterpartyId) {
        throw err("TRADE_OWNERSHIP_CHANGED", "Requested instances are no longer owned by the counterparty");
      }
      if (row.teamSlot) {
        throw err("TRADE_INSTANCE_IN_TEAM", "Counterparty has an instance in the team; trade blocked");
      }
    }

    await tx.teamSlot.deleteMany({ where: { instanceId: { in: allIds } } });

    for (const id of initiatorIds) {
      await tx.instance.update({
        where: { id },
        data: { ownerId: proposal.counterpartyId },
      });
    }
    for (const id of counterpartyIds) {
      await tx.instance.update({
        where: { id },
        data: { ownerId: proposal.initiatorId },
      });
    }

    await tx.tradeProposal.update({
      where: { id: proposal.id },
      data: { status: "ACCEPTED" },
    });

    // Qualquer outra proposta pendente que envolva instâncias transferidas
    // fica inválida e deve ser cancelada automaticamente.
    await tx.tradeProposal.updateMany({
      where: {
        status: "PENDING",
        id: { not: proposal.id },
        items: { some: { instanceId: { in: allIds } } },
      },
      data: { status: "CANCELLED" },
    });

    return proposal.id;
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} proposalId
 * @param {string} userId
 * @param {'decline'|'cancel'} action
 */
async function declineOrCancelTradeProposal(prisma, proposalId, userId, action) {
  const uid = String(userId);
  const pid = String(proposalId);

  const proposal = await prisma.tradeProposal.findFirst({
    where: {
      id: pid,
      status: "PENDING",
      ...(action === "decline" ? { counterpartyId: uid } : { initiatorId: uid }),
    },
    select: { id: true },
  });

  if (!proposal) {
    throw err("TRADE_NOT_FOUND", "Trade proposal not found, not pending, or not allowed for this user");
  }

  await prisma.tradeProposal.update({
    where: { id: proposal.id },
    data: { status: action === "decline" ? "DECLINED" : "CANCELLED" },
  });

  return proposal.id;
}

module.exports = {
  createTradeProposal,
  getTradeProposalForUser,
  listTradeProposalsForUser,
  acceptTradeProposal,
  declineOrCancelTradeProposal,
  instanceSelect,
};
