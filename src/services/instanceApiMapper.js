const { getSerialClass } = require("./cardInstanceMintService");

/**
 * Formato de instância alinhado a `GET /user/team` / `GET /user/instances` para o app.
 * @param {import("@prisma/client").Instance & { card: import("@prisma/client").Player }} row
 */
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

/** Select Prisma para carregar uma instância no formato esperado por `mapInstanceRow`. */
const INSTANCE_FULL_SELECT = {
  id: true,
  cardId: true,
  serialNumber: true,
  serialMax: true,
  spawnSource: true,
  spawnedAt: true,
  updatedAt: true,
  foundWhen: true,
  foundWhereCity: true,
  foundWhereState: true,
  foundWhereLat: true,
  foundWhereLng: true,
  latitude: true,
  longitude: true,
  h3RoomCell: true,
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

module.exports = {
  mapInstanceRow,
  INSTANCE_FULL_SELECT,
};
