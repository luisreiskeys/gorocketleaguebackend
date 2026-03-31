const { prisma } = require("../db/prisma");
const { getCardSpawnConfig } = require("../config/cardSpawnConfig");
const { resUserCell } = require("../config/h3Resolutions");
const { getCellCenterLatLng } = require("../utils/cellOwnership");
const {
  createSeededRng,
  proposeSpawnPlacement,
  pickRandomSpawnCell,
  randomLatLngInCell,
} = require("../rules/coinSpawnRules");

/**
 * Sorteia lat/lng dentro da resRoomCell, longe do centro (bandeira).
 */
function pickRandomLatLngInRoomCell(roomCell, roomId, instanceId, flagLat, flagLng, minFromFlagM) {
  const rng = createSeededRng(`card:${String(roomId)}:${String(instanceId)}`);
  const placement = proposeSpawnPlacement({
    roomCell: String(roomCell),
    spawnRes: resUserCell,
    flagLat,
    flagLng,
    minFromFlagM,
    rng,
    maxAttempts: 16,
  });
  if (placement) {
    return { lat: placement.lat, lng: placement.lng };
  }
  const rng2 = createSeededRng(`cardfb:${String(roomId)}:${String(instanceId)}`);
  for (let j = 0; j < 10; j += 1) {
    const h3SpawnCell = pickRandomSpawnCell(String(roomCell), resUserCell, rng2);
    if (!h3SpawnCell) continue;
    const pos = randomLatLngInCell(h3SpawnCell, rng2);
    if (pos && [pos.lat, pos.lng].every(Number.isFinite)) {
      return { lat: pos.lat, lng: pos.lng };
    }
  }
  const c = getCellCenterLatLng(String(roomCell));
  return { lat: c.lat, lng: c.lng };
}

/**
 * Reivindica instancias do pool global (world_pool) para uma CellRoom ativa.
 * So grava h3RoomCell = roomCell desta sala — nunca outra resRoomCell.
 * Posicao: aleatoria dentro da celula (filhos H3_RES_USER_CELL), evitando o centro da bandeira.
 */
async function claimWorldPoolInstancesForRoom({ roomId, roomCell, targetCount }) {
  if (!roomId || !roomCell || targetCount <= 0) return { claimed: 0 };

  const take = Math.min(200, Math.max(0, Math.floor(Number(targetCount))));
  const center = getCellCenterLatLng(String(roomCell));
  const flagLat = Number(center.lat);
  const flagLng = Number(center.lng);
  const minFromFlagM = getCardSpawnConfig().cardMinFromFlagM;

  return prisma.$transaction(async (tx) => {
    const candidates = await tx.instance.findMany({
      where: {
        spawnSource: "world_pool",
        ownerId: null,
        foundWhen: null,
        reservedByRoomId: null,
        OR: [{ h3RoomCell: null }, { h3RoomCell: String(roomCell) }],
      },
      orderBy: { spawnedAt: "asc" },
      take,
      select: { id: true },
    });

    if (candidates.length === 0) {
      return { claimed: 0 };
    }

    let claimed = 0;
    for (const c of candidates) {
      const { lat, lng } = pickRandomLatLngInRoomCell(roomCell, roomId, c.id, flagLat, flagLng, minFromFlagM);
      await tx.instance.update({
        where: { id: c.id },
        data: {
          reservedByRoomId: String(roomId),
          h3RoomCell: String(roomCell),
          latitude: lat,
          longitude: lng,
        },
      });
      claimed += 1;
    }

    return { claimed };
  });
}

/**
 * Ao encerrar a sala: instancias world_pool ainda nao coletadas voltam ao pool global.
 */
async function releaseRoomReservedInstances(roomId) {
  if (!roomId) return { released: 0 };

  const result = await prisma.instance.updateMany({
    where: {
      reservedByRoomId: String(roomId),
      ownerId: null,
      foundWhen: null,
      spawnSource: "world_pool",
    },
    data: {
      reservedByRoomId: null,
      h3RoomCell: null,
      latitude: 0,
      longitude: 0,
    },
  });

  return { released: result.count };
}

function getRoomActiveInstancesMax() {
  return getCardSpawnConfig().roomActiveInstancesMax;
}

module.exports = {
  claimWorldPoolInstancesForRoom,
  releaseRoomReservedInstances,
  getRoomActiveInstancesMax,
};
