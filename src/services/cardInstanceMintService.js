function isUniqueSerialError(err) {
  return err?.code === "P2002";
}

function randomIntInclusive(min, max) {
  const lo = Math.ceil(Number(min));
  const hi = Math.floor(Number(max));
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function pickRandomAvailableSerial(tx, cardId, serialMax, randomProbeAttempts = 16) {
  const max = Math.max(1, Number(serialMax));
  // Fase 1: tentativas aleatorias baratas.
  for (let i = 0; i < randomProbeAttempts; i += 1) {
    const serialCandidate = randomIntInclusive(1, max);
    const exists = await tx.instance.findUnique({
      where: {
        cardId_serialNumber: {
          cardId: Number(cardId),
          serialNumber: serialCandidate,
        },
      },
      select: { id: true },
    });
    if (!exists) return serialCandidate;
  }

  // Fase 2: fallback deterministico para garantir disponibilidade.
  const usedRows = await tx.instance.findMany({
    where: { cardId: Number(cardId) },
    select: { serialNumber: true },
  });
  const used = new Set(usedRows.map((r) => Number(r.serialNumber)).filter((n) => Number.isFinite(n) && n > 0));
  const remaining = [];
  for (let n = 1; n <= max; n += 1) {
    if (!used.has(n)) remaining.push(n);
  }
  if (remaining.length === 0) return null;
  return remaining[randomIntInclusive(0, remaining.length - 1)];
}

function getSerialClass(serialNumber, serialMax) {
  const n = Number(serialNumber);
  const m = Number(serialMax);
  if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0) return "standard";
  if (n === 1 || n === m) return "extreme";
  if (n <= Math.max(3, Math.floor(m * 0.01))) return "elite";
  return "standard";
}

async function mintInstanceWithSerial(tx, params) {
  const {
    cardId,
    ownerId = null,
    latitude,
    longitude,
    h3RoomCell = null,
    reservedByRoomId = null,
    spawnSource = null,
    foundWhen = null,
    foundWhereCity = null,
    foundWhereState = null,
    foundWhereLat = null,
    foundWhereLng = null,
    maxRetries = 8,
  } = params;

  const player = await tx.player.findUnique({
    where: { id: Number(cardId) },
    select: { max_supply: true },
  });
  const serialMax = Math.max(0, Number(player?.max_supply ?? 0));
  if (serialMax <= 0) {
    throw Object.assign(new Error("CARD_MAX_SUPPLY_REACHED"), { code: "CARD_MAX_SUPPLY_REACHED" });
  }

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const serialNumber = await pickRandomAvailableSerial(tx, Number(cardId), serialMax);
    if (!serialNumber) {
      throw Object.assign(new Error("CARD_MAX_SUPPLY_REACHED"), { code: "CARD_MAX_SUPPLY_REACHED" });
    }

    try {
      const created = await tx.instance.create({
        data: {
          cardId: Number(cardId),
          serialNumber,
          serialMax,
          ownerId: ownerId ? String(ownerId) : null,
          latitude: Number(latitude),
          longitude: Number(longitude),
          h3RoomCell: h3RoomCell ? String(h3RoomCell) : null,
          reservedByRoomId: reservedByRoomId ? String(reservedByRoomId) : null,
          spawnSource: spawnSource ? String(spawnSource) : null,
          foundWhen: foundWhen ?? null,
          foundWhereCity,
          foundWhereState,
          foundWhereLat,
          foundWhereLng,
        },
        select: {
          id: true,
          cardId: true,
          serialNumber: true,
          serialMax: true,
        },
      });
      return {
        ...created,
        serialClass: getSerialClass(created.serialNumber, created.serialMax),
      };
    } catch (err) {
      if (isUniqueSerialError(err)) continue;
      throw err;
    }
  }

  throw Object.assign(new Error("SERIAL_ALLOCATION_CONFLICT"), { code: "SERIAL_ALLOCATION_CONFLICT" });
}

module.exports = {
  mintInstanceWithSerial,
  getSerialClass,
};
