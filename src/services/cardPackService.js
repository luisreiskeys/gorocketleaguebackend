const { prisma } = require("../db/prisma");
const { getCardSpawnConfig } = require("../config/cardSpawnConfig");
const { rollCardId, createRarityPool } = require("./cardSpawnService");
const { mintInstanceWithSerial } = require("./cardInstanceMintService");
const { createInitialTeam } = require("./teamService");
const { incrementPlayerFoundProgress } = require("./playerProgressService");

function hasElapsedHours(from, now, hours) {
  if (!from) return true;
  const diffMs = now.getTime() - new Date(from).getTime();
  return diffMs >= Number(hours) * 60 * 60 * 1000;
}

function buildOwnedInstanceData(cardId, user) {
  const lat = Number(user?.lat ?? 0);
  const lng = Number(user?.lng ?? 0);
  const city = user?.city ?? null;
  const state = user?.state ?? null;
  return {
    cardId,
    ownerId: String(user.id),
    latitude: Number.isFinite(lat) ? lat : 0,
    longitude: Number.isFinite(lng) ? lng : 0,
    h3RoomCell: user?.h3RoomCell ? String(user.h3RoomCell) : null,
    spawnSource: "user_pack",
    foundWhen: new Date(),
    foundWhereCity: city,
    foundWhereState: state,
    foundWhereLat: Number.isFinite(lat) ? lat : null,
    foundWhereLng: Number.isFinite(lng) ? lng : null,
  };
}

async function createPackInstances(tx, user, count) {
  const createdIds = [];
  const foundByCardId = new Map();
  const cfg = getCardSpawnConfig();
  const cache = await createRarityPool(cfg);
  for (let i = 0; i < count; i += 1) {
    const cardId = await rollCardId(cfg, cache);
    if (!cardId) continue;
    const payload = buildOwnedInstanceData(cardId, user);
    const created = await mintInstanceWithSerial(tx, {
      cardId: payload.cardId,
      ownerId: payload.ownerId,
      latitude: payload.latitude,
      longitude: payload.longitude,
      h3RoomCell: payload.h3RoomCell,
      spawnSource: payload.spawnSource,
      foundWhen: payload.foundWhen,
      foundWhereCity: payload.foundWhereCity,
      foundWhereState: payload.foundWhereState,
      foundWhereLat: payload.foundWhereLat,
      foundWhereLng: payload.foundWhereLng,
    });
    createdIds.push(created);
    const key = Number(created.cardId);
    foundByCardId.set(key, (foundByCardId.get(key) || 0) + 1);
  }

  for (const [cardId, qty] of foundByCardId.entries()) {
    // Pack já nasce "encontrado" (owner + foundWhen), então reflete no progresso.
    await incrementPlayerFoundProgress(tx, cardId, qty);
  }
  return createdIds;
}

async function grantEligiblePacks(userId) {
  const cfg = getCardSpawnConfig();
  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { id: String(userId) },
      select: {
        id: true,
        firstPack: true,
        lastFreePack: true,
        lat: true,
        lng: true,
        h3RoomCell: true,
      },
    });
    if (!user) return { grantedInitial: false, grantedDaily: false, initialCards: [], dailyCards: [] };

    let grantedInitial = false;
    let grantedDaily = false;
    let initialCards = [];
    let dailyCards = [];

    if (!user.firstPack) {
      initialCards = await createPackInstances(tx, user, Number(cfg.initialPackSize));
      grantedInitial = initialCards.length > 0;
      await tx.user.update({
        where: { id: user.id },
        data: {
          firstPack: true,
          // Evita conceder daily pack no mesmo dia do first pack.
          lastFreePack: now,
        },
      });
      // Time automático com as 5 cartas do primeiro pack (tamanho inicial do pack = 5).
      if (grantedInitial && initialCards.length === 5) {
        await createInitialTeam(tx, user.id, initialCards);
      }
    }

    const referenceLastFreePack = grantedInitial ? now : user.lastFreePack;
    const shouldGrantDaily = hasElapsedHours(referenceLastFreePack, now, Number(cfg.dailyCooldownHours));
    if (shouldGrantDaily) {
      dailyCards = await createPackInstances(tx, user, Number(cfg.dailyPackSize));
      grantedDaily = dailyCards.length > 0;
      await tx.user.update({
        where: { id: user.id },
        data: { lastFreePack: now },
      });
    }

    return { grantedInitial, grantedDaily, initialCards, dailyCards };
  });
}

module.exports = {
  grantEligiblePacks,
};
