const path = require("path");
const fs = require("fs");
const { prisma } = require("../db/prisma");
const { requireUserToken } = require("../middlewares/auth");
const { getSerialClass } = require("../services/cardInstanceMintService");

const AVATARS_DIR =
  process.env.AVATARS_DIR || path.join(__dirname, "..", "..", "data", "avatars");

/**
 * Retorna a contagem de avatars disponíveis em data/avatars.
 * As URLs seguem o padrão: /public_assets/avatars/{id}.webp (id de 1 a count).
 * GET /avatars
 */
async function getAvatars(request, reply) {
  try {
    if (!fs.existsSync(AVATARS_DIR)) {
      return reply.send({ count: 0 });
    }
    const files = fs.readdirSync(AVATARS_DIR);
    const imageExtensions = [".webp", ".png", ".jpg", ".jpeg", ".gif"];
    const count = files.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return imageExtensions.includes(ext);
    }).length;

    return reply.send({ count });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list avatars",
      message: err.message,
    });
  }
}

/**
 * Atualiza dados do usuário autenticado (nome, avatar, email/provider).
 * PATCH /user
 * Body: { username?, avatarId?, email?, provider?, providerId? }
 */
async function updateUser(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const body = request.body || {};
  const updates = {};

  if (body.username !== undefined) {
    const username = String(body.username).trim();
    if (!username) {
      return reply.code(400).send({ error: "username cannot be empty" });
    }
    const existing = await prisma.user.findFirst({
      where: { username, id: { not: userId } },
    });
    if (existing) {
      return reply.code(409).send({ error: "Username already in use" });
    }
    updates.username = username;
  }

  if (body.avatarId !== undefined) {
    const avatarId = body.avatarId === null ? null : Number(body.avatarId);
    if (avatarId !== null && (Number.isNaN(avatarId) || avatarId < 1)) {
      return reply.code(400).send({ error: "avatarId must be a positive number or null" });
    }
    updates.avatarId = avatarId;
  }

  if (body.email !== undefined) {
    const email = body.email === null || body.email === "" ? null : String(body.email).trim();
    if (email) {
      const existing = await prisma.user.findFirst({
        where: { email, id: { not: userId } },
      });
      if (existing) {
        return reply.code(409).send({ error: "Email already in use" });
      }
    }
    updates.email = email;
  }

  if (body.provider !== undefined) {
    updates.provider = body.provider === null || body.provider === "" ? null : String(body.provider).trim();
  }
  if (body.providerId !== undefined) {
    updates.providerId = body.providerId === null || body.providerId === "" ? null : String(body.providerId).trim();
  }

  if (Object.keys(updates).length === 0) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        avatarId: true,
        email: true,
        provider: true,
        providerId: true,
        level: true,
        xp: true,
        fuel: true,
        coverage: true,
      },
    });
    if (!user) {
      return reply.code(404).send({ error: "User not found" });
    }
    return reply.send(user);
  }

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: updates,
      select: {
        id: true,
        username: true,
        avatarId: true,
        email: true,
        provider: true,
        providerId: true,
        level: true,
        xp: true,
        fuel: true,
        coverage: true,
      },
    });
    return reply.send(user);
  } catch (err) {
    if (err.code === "P2002") {
      return reply.code(409).send({ error: "Unique constraint violation", field: err.meta?.target?.[0] });
    }
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to update user",
      message: err.message,
    });
  }
}

/**
 * Monta o `where` do Prisma para GET /user/instances (filtros opcionais sobre a carta e a instância).
 */
function buildUserInstancesWhere(userId, query) {
  const where = { ownerId: userId };
  const cardFilters = [];

  const search = String(query?.search ?? query?.q ?? "").trim();
  if (search) {
    cardFilters.push({ name: { contains: search, mode: "insensitive" } });
  }

  const cardIdRaw = query?.cardId;
  if (cardIdRaw !== undefined && cardIdRaw !== null && String(cardIdRaw).trim() !== "") {
    const cardId = parseInt(cardIdRaw, 10);
    if (Number.isFinite(cardId)) {
      where.cardId = cardId;
    }
  }

  const nationRaw = query?.nation ?? query?.nationality;
  if (nationRaw !== undefined && nationRaw !== null && String(nationRaw).trim() !== "") {
    const nations = String(nationRaw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (nations.length === 1) {
      cardFilters.push({ nation: { equals: nations[0], mode: "insensitive" } });
    } else if (nations.length > 1) {
      cardFilters.push({
        OR: nations.map((n) => ({ nation: { equals: n, mode: "insensitive" } })),
      });
    }
  }

  const ovrMin = parseInt(query?.ovrMin, 10);
  const ovrMax = parseInt(query?.ovrMax, 10);
  const ovrCond = {};
  if (Number.isFinite(ovrMin)) ovrCond.gte = ovrMin;
  if (Number.isFinite(ovrMax)) ovrCond.lte = ovrMax;
  if (Object.keys(ovrCond).length > 0) {
    cardFilters.push({ ovr: ovrCond });
  }

  const position = String(query?.position ?? "").trim();
  if (position) {
    cardFilters.push({ position: { equals: position, mode: "insensitive" } });
  }

  const spawnRaw = query?.spawnSource ?? query?.instanceType;
  if (spawnRaw !== undefined && spawnRaw !== null && String(spawnRaw).trim() !== "") {
    const sources = String(spawnRaw)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (sources.length === 1) {
      where.spawnSource = sources[0];
    } else if (sources.length > 1) {
      where.spawnSource = { in: sources };
    }
  }

  if (cardFilters.length > 0) {
    where.card = { AND: cardFilters };
  }

  return where;
}

const instanceRowSelect = {
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
};

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

/**
 * Lista instâncias de cartas do usuário autenticado (coleção).
 * GET /user/instances
 * Query: limit?, offset?, search|q?, cardId?, nation|nationality?, ovrMin?, ovrMax?, position?, spawnSource|instanceType?
 * Header: Authorization: Bearer <access_token>
 */
async function listUserInstances(request, reply) {
  const userId = request.user?.sub;
  if (!userId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const limitRaw = request.query?.limit;
  const offsetRaw = request.query?.offset;
  let limit = parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  let offset = parseInt(offsetRaw, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    const where = buildUserInstancesWhere(userId, request.query || {});

    const [total, rows] = await Promise.all([
      prisma.instance.count({ where }),
      prisma.instance.findMany({
        where,
        orderBy: [
          { card: { ovr: { sort: "desc", nulls: "last" } } },
          { spawnedAt: "desc" },
        ],
        skip: offset,
        take: limit,
        select: instanceRowSelect,
      }),
    ]);

    const instances = rows.map(mapInstanceRow);

    return reply.send({
      total,
      limit,
      offset,
      instances,
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list instances",
      message: err.message,
    });
  }
}

/**
 * Lista instâncias encontradas de uma carta específica (Player), para iniciar trade.
 * GET /players/:playerId/instances
 */
async function listFoundInstancesByCard(request, reply) {
  const authUserId = request.user?.sub;
  if (!authUserId) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const playerId = Number(request.params?.playerId);
  if (!Number.isFinite(playerId) || playerId <= 0) {
    return reply.code(400).send({ error: "playerId must be a positive number" });
  }

  const limitRaw = request.query?.limit;
  const offsetRaw = request.query?.offset;
  let limit = parseInt(limitRaw, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 100) limit = 100;
  let offset = parseInt(offsetRaw, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  try {
    const cardExists = await prisma.player.findUnique({
      where: { id: playerId },
      select: { id: true },
    });
    if (!cardExists) {
      return reply.code(404).send({ error: "Player not found" });
    }

    const where = {
      cardId: playerId,
      foundWhen: { not: null },
      ownerId: { not: null },
    };

    const [total, rows] = await Promise.all([
      prisma.instance.count({ where }),
      prisma.instance.findMany({
        where,
        orderBy: [
          { serialNumber: "asc" },
          { spawnedAt: "desc" },
        ],
        skip: offset,
        take: limit,
        select: {
          ...instanceRowSelect,
          owner: {
            select: {
              id: true,
              username: true,
              avatarId: true,
            },
          },
        },
      }),
    ]);

    const instances = rows.map((row) => ({
      ...mapInstanceRow(row),
      owner: row.owner
        ? {
            id: row.owner.id,
            username: row.owner.username,
            avatarId: row.owner.avatarId,
          }
        : null,
    }));

    return reply.send({
      playerId,
      total,
      limit,
      offset,
      instances,
    });
  } catch (err) {
    request.log?.error?.(err);
    return reply.code(500).send({
      error: "Failed to list found instances for player",
      message: err.message,
    });
  }
}

async function userRoutes(fastify) {
  fastify.get("/avatars", getAvatars);
  fastify.patch("/user", { preHandler: requireUserToken }, updateUser);
  fastify.get("/user/instances", { preHandler: requireUserToken }, listUserInstances);
  fastify.get("/players/:playerId/instances", { preHandler: requireUserToken }, listFoundInstancesByCard);
}

module.exports = userRoutes;
