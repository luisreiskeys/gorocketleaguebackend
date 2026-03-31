const { prisma } = require("../db/prisma");
const { requireUserToken } = require("../middlewares/auth");
const { getSerialClass } = require("../services/cardInstanceMintService");
const {
  createTradeProposal,
  getTradeProposalForUser,
  listTradeProposalsForUser,
  acceptTradeProposal,
  declineOrCancelTradeProposal,
} = require("../services/tradeService");

function mapInstanceRow(row) {
  return {
    id: row.id,
    cardId: row.cardId,
    serialNumber: row.serialNumber,
    serialMax: row.serialMax,
    serialLabel: `${row.serialNumber}/${row.serialMax}`,
    serialClass: getSerialClass(row.serialNumber, row.serialMax),
    spawnSource: row.spawnSource,
    spawnedAt: row.spawnedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    foundWhen: row.foundWhen ? row.foundWhen.toISOString() : null,
    foundWhere: {
      city: row.foundWhereCity,
      state: row.foundWhereState,
      lat: row.foundWhereLat,
      lng: row.foundWhereLng,
    },
    spawnLocation: {
      lat: row.latitude,
      lng: row.longitude,
      h3RoomCell: row.h3RoomCell,
    },
    card: {
      id: row.card.id,
      name: row.card.name,
      ovr: row.card.ovr,
      url: row.card.url,
      maxSupply: row.card.max_supply,
      nation: row.card.nation,
      team: row.card.team,
    },
  };
}

function mapProposal(p) {
  if (!p) return null;
  const fromInitiator = [];
  const fromCounterparty = [];
  for (const it of p.items || []) {
    const mapped = mapInstanceRow(it.instance);
    if (it.side === "FROM_INITIATOR") fromInitiator.push(mapped);
    else fromCounterparty.push(mapped);
  }
  return {
    id: p.id,
    status: p.status,
    initiator: p.initiator,
    counterparty: p.counterparty,
    offerFromInitiator: fromInitiator,
    offerFromCounterparty: fromCounterparty,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function tradeErrorReply(reply, err) {
  const code = err?.code;
  const message = err?.message || "Trade error";
  const map = {
    TRADE_SELF: [400, message],
    TRADE_EMPTY_SIDE: [400, message],
    TRADE_DUPLICATE_INSTANCE: [400, message],
    TRADE_INSTANCE_NOT_OWNED: [400, message],
    TRADE_INSTANCE_IN_TEAM: [400, message],
    TRADE_INSTANCE_PENDING_ELSEWHERE: [409, message],
    TRADE_USER_NOT_FOUND: [404, message],
    TRADE_NOT_FOUND: [404, message],
    TRADE_OWNERSHIP_CHANGED: [409, message],
  };
  const [status, msg] = map[code] || [500, message];
  if (status === 500) {
    return reply.code(500).send({ error: "Failed trade operation", message: msg });
  }
  return reply.code(status).send({ error: msg, code });
}

async function postTrade(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const counterpartyId = body.counterpartyId;
  const offerInstanceIds = body.offerInstanceIds;
  const requestInstanceIds = body.requestInstanceIds;

  if (!counterpartyId || typeof counterpartyId !== "string") {
    return reply.code(400).send({ error: "counterpartyId is required" });
  }
  if (!Array.isArray(offerInstanceIds) || !Array.isArray(requestInstanceIds)) {
    return reply.code(400).send({ error: "offerInstanceIds and requestInstanceIds must be arrays" });
  }

  try {
    const id = await createTradeProposal(prisma, {
      initiatorId: userId,
      counterpartyId,
      offerInstanceIds,
      requestInstanceIds,
    });
    const proposal = await getTradeProposalForUser(prisma, id, userId);
    return reply.code(201).send(mapProposal(proposal));
  } catch (err) {
    if (err?.code) {
      return tradeErrorReply(reply, err);
    }
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to create trade", message: err.message });
  }
}

async function getTradesList(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const q = request.query || {};
  const role = q.role;
  if (role && role !== "initiator" && role !== "counterparty" && role !== "all") {
    return reply.code(400).send({ error: "role must be initiator, counterparty, or all" });
  }

  const status = q.status;
  const allowed = ["PENDING", "ACCEPTED", "DECLINED", "CANCELLED"];
  if (status && !allowed.includes(String(status))) {
    return reply.code(400).send({ error: `status must be one of: ${allowed.join(", ")}` });
  }

  try {
    const { items, total, take, skip } = await listTradeProposalsForUser(prisma, {
      userId,
      role: role || "all",
      status: status || undefined,
      take: q.take,
      skip: q.skip,
    });
    return reply.send({
      items: items.map(mapProposal),
      total,
      take,
      skip,
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to list trades", message: err.message });
  }
}

async function getTradeById(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const id = request.params?.id;
  try {
    const proposal = await getTradeProposalForUser(prisma, id, userId);
    if (!proposal) {
      return reply.code(404).send({ error: "Trade proposal not found" });
    }
    return reply.send(mapProposal(proposal));
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to load trade", message: err.message });
  }
}

async function postAccept(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const id = request.params?.id;
  try {
    await acceptTradeProposal(prisma, id, userId);
    const proposal = await getTradeProposalForUser(prisma, id, userId);
    return reply.send(mapProposal(proposal));
  } catch (err) {
    if (err?.code) {
      return tradeErrorReply(reply, err);
    }
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to accept trade", message: err.message });
  }
}

async function postDecline(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const id = request.params?.id;
  try {
    await declineOrCancelTradeProposal(prisma, id, userId, "decline");
    const proposal = await getTradeProposalForUser(prisma, id, userId);
    return reply.send(mapProposal(proposal));
  } catch (err) {
    if (err?.code) {
      return tradeErrorReply(reply, err);
    }
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to decline trade", message: err.message });
  }
}

async function deleteCancel(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const id = request.params?.id;
  try {
    await declineOrCancelTradeProposal(prisma, id, userId, "cancel");
    const proposal = await getTradeProposalForUser(prisma, id, userId);
    return reply.send(mapProposal(proposal));
  } catch (err) {
    if (err?.code) {
      return tradeErrorReply(reply, err);
    }
    request.log?.error?.(err);
    return reply.code(500).send({ error: "Failed to cancel trade", message: err.message });
  }
}

async function tradeRoutes(fastify) {
  fastify.post("/trades", { preHandler: requireUserToken }, postTrade);
  fastify.get("/trades", { preHandler: requireUserToken }, getTradesList);
  fastify.get("/trades/:id", { preHandler: requireUserToken }, getTradeById);
  fastify.post("/trades/:id/accept", { preHandler: requireUserToken }, postAccept);
  fastify.post("/trades/:id/decline", { preHandler: requireUserToken }, postDecline);
  fastify.delete("/trades/:id", { preHandler: requireUserToken }, deleteCancel);
}

module.exports = tradeRoutes;
