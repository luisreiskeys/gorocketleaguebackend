/**
 * Ownership de células H3 + compactação hierárquica.
 *
 * Observações importantes:
 * - "Ownership" é persistido por `h3_index` único.
 * - Quando consultamos um índice, escolhemos o registro mais "dominante"
 *   (subindo a hierarquia a partir do índice original).
 * - A compactação só remove filhos quando o usuário possui todos os filhos
 *   do mesmo pai (um pai em res menor "dominando" os filhos em res maior).
 */
const { cellToParent, cellToChildren, cellToLatLng, cellArea } = require("h3-js");

async function getDominantOwnershipRecord(prisma, { h3Index, startResolution, maxSteps = 10 }) {
  if (!h3Index || startResolution == null) return null;

  let currentIndex = String(h3Index);
  let currentResolution = Number(startResolution);
  let steps = 0;

  while (currentIndex && currentResolution >= 0 && steps < maxSteps) {
    // Como `h3Index` é UNIQUE, a busca por findUnique é direta e barata.
    const ownership = await prisma.cellOwnership.findUnique({
      where: { h3Index: currentIndex },
      select: { id: true, h3Index: true, resolution: true, ownerUserId: true },
    });

    if (ownership) return ownership;

    if (currentResolution <= 0) break;
    currentResolution -= 1;
    currentIndex = cellToParent(currentIndex, currentResolution);
    steps += 1;
  }

  return null;
}

async function captureOwnershipDominant(prisma, { h3Index, startResolution, userId }) {
  const existing = await getDominantOwnershipRecord(prisma, { h3Index, startResolution });

  if (existing) {
    await prisma.cellOwnership.update({
      where: { id: existing.id },
      data: { ownerUserId: userId },
    });
    return { h3Index: existing.h3Index, resolution: existing.resolution };
  }

  await prisma.cellOwnership.create({
    data: {
      h3Index,
      resolution: startResolution,
      ownerUserId: userId,
    },
  });

  return { h3Index, resolution: startResolution };
}

async function checkAndCompactUpward(prisma, { h3Index, resolution, userId, maxSteps = 6 }) {
  let currentIndex = String(h3Index);
  let currentResolution = Number(resolution);
  let steps = 0;

  while (currentResolution > 0 && steps < maxSteps) {
    const parentResolution = currentResolution - 1;
    const parentIndex = cellToParent(currentIndex, parentResolution);

    // Crianças do "pai" (em resolução atual).
    const children = cellToChildren(parentIndex, currentResolution);
    if (!Array.isArray(children) || children.length === 0) return;

    // Regra direta: conta ownership "nos próprios children indices" (os filhos em res maior).
    const owned = await prisma.cellOwnership.findMany({
      where: {
        h3Index: { in: children },
        ownerUserId: userId,
      },
      select: { h3Index: true },
    });

    const ownedCount = owned.length;
    if (ownedCount === children.length) {
      // Remove todos os filhos já compactados (garante crescimento sub-logarítmico).
      await prisma.cellOwnership.deleteMany({
        where: { h3Index: { in: children } },
      });

      // Upsert do pai (res menor) para o usuário.
      await prisma.cellOwnership.upsert({
        where: { h3Index: parentIndex },
        create: {
          h3Index: parentIndex,
          resolution: parentResolution,
          ownerUserId: userId,
        },
        update: {
          resolution: parentResolution,
          ownerUserId: userId,
        },
      });

      // Segue tentando compactar ainda mais acima.
      currentIndex = parentIndex;
      currentResolution = parentResolution;
      steps += 1;
      continue;
    }

    break; // se não tem todos os filhos, não compacta para cima
  }
}

function getCellCenterLatLng(h3Index) {
  const pos = cellToLatLng(h3Index);
  // h3-js pode retornar [lat, lng] (array) ou objeto { lat, lng }.
  if (Array.isArray(pos)) {
    return { lat: Number(pos[0]), lng: Number(pos[1]) };
  }
  return { lat: Number(pos?.lat), lng: Number(pos?.lng) };
}

async function getUserOwnershipStats(prisma, ownerUserId, baseResolution) {
  if (!ownerUserId) {
    return { flagsOwned: 0, ownedAreaKm2: 0 };
  }
  const cells = await prisma.cellOwnership.findMany({
    where: { ownerUserId },
    select: { h3Index: true, resolution: true },
  });
  let totalArea = 0;
  let totalEquivalentFlags = 0;
  const baseRes = Number(baseResolution);
  for (const c of cells) {
    try {
      totalArea += cellArea(c.h3Index, "km2");
    } catch {
      // ignora células inválidas
    }

    // Equivalência por resRoomCell:
    // ex base=8 => res8=1, res7=7, res6=49...
    const diff = Number.isFinite(baseRes) ? baseRes - Number(c.resolution) : 0;
    if (diff >= 0) {
      totalEquivalentFlags += Math.pow(7, diff);
    } else {
      // Não esperamos resoluções > base aqui; conta no mínimo 1 unidade.
      totalEquivalentFlags += 1;
    }
  }
  return {
    flagsOwned: totalEquivalentFlags,
    ownedAreaKm2: totalArea,
  };
}

module.exports = {
  getDominantOwnershipRecord,
  captureOwnershipDominant,
  checkAndCompactUpward,
  getCellCenterLatLng,
  getUserOwnershipStats,
};

