/**
 * Runtime de coins por CellRoom: spawn periódico, coleta autoritativa + ledger.
 * Coleta: mesma regra da flag — colisão em H3_RES_COLLIDE (default 12) no updatePosition.
 */
const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { latLngToCell } = require("h3-js");
const { CoinState } = require("../state/CoinState");
const { getCoinSpawnConfig } = require("../../config/coinSpawnConfig");
const { resUserCell, resCollide } = require("../../config/h3Resolutions");
const { createSeededRng, proposeSpawnPlacement, rollCoinValue } = require("../../rules/coinSpawnRules");
const { createCollectRateLimiter } = require("../../rules/coinPickupRules");
const { latLngToCollideCell, cellsCollideForPickup } = require("../../rules/coinCollisionRules");
const { applyCoinDelta } = require("../../services/coinService");

/**
 * @param {*} room instância Colyseus Room (CellRoom)
 */
function attachCoinRoomRuntime(room) {
  const config = getCoinSpawnConfig();
  const rng = createSeededRng(`${room.roomCell ?? ""}:${room.roomId ?? ""}`);
  const rateLimiter = createCollectRateLimiter(config.collectPerMinute);
  /** Evita corrida: dois updatePosition antes do await remover a coin. */
  const pickupLocks = new Set();

  /** @type {ReturnType<typeof setInterval> | null} */
  let spawnTimer = null;
  /** @type {ReturnType<typeof setImmediate> | null} */
  let deferredTickHandle = null;
  const lastPositionLogBySession = new Map();
  const debugLogPath = path.resolve(process.cwd(), "logs", "coin-runtime-debug.ndjson");

  function appendDebugLog(event, payload = {}) {
    try {
      const dir = path.dirname(debugLogPath);
      fs.mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        event,
        roomId: String(room.roomId ?? ""),
        roomCell: String(room.roomCell ?? ""),
        ...payload,
      });
      fs.appendFileSync(debugLogPath, `${line}\n`, "utf8");
    } catch {
      // Não quebrar runtime por erro de logging.
    }
  }

  function trySpawnOne(nowMs) {
    if (!config.enabled || !room.roomCell || !room.state) return false;
    if (room.state.users.size === 0) return false;
    if (room.state.coins.size >= config.maxActiveCoins) return false;

    const flagLat = Number(room.state.flag?.lat ?? 0);
    const flagLng = Number(room.state.flag?.lng ?? 0);
    const minSpacingRes = Number(config.minSpacingRes);
    const occupiedSpacingCells = new Set();
    room.state.coins.forEach((coin) => {
      try {
        const spacingCell = String(latLngToCell(Number(coin.lat), Number(coin.lng), minSpacingRes));
        if (spacingCell) occupiedSpacingCells.add(spacingCell);
      } catch {
        // Ignora coin inválida e segue com os demais candidatos.
      }
    });

    const placement = proposeSpawnPlacement({
      roomCell: room.roomCell,
      spawnRes: resUserCell,
      flagLat,
      flagLng,
      minFromFlagM: config.minFromFlagM,
      rng,
      maxAttempts: 14,
      isPlacementAllowed: (pos) => {
        if (![pos?.lat, pos?.lng].every(Number.isFinite)) return false;
        try {
          const spacingCell = String(latLngToCell(Number(pos.lat), Number(pos.lng), minSpacingRes));
          return !occupiedSpacingCells.has(spacingCell);
        } catch {
          return false;
        }
      },
    });
    if (!placement) {
      appendDebugLog("spawn.rejected", {
        reason: "no_valid_placement",
        activeCoins: Number(room.state.coins.size),
      });
      return false;
    }

    const id = randomUUID();
    const value = rollCoinValue(config.minValue, config.maxValue, rng);
    const coin = new CoinState();
    coin.id = id;
    coin.lat = placement.lat;
    coin.lng = placement.lng;
    coin.value = value;
    coin.h3SpawnCell = placement.h3SpawnCell ?? "";
    coin.h3CollideCell = latLngToCollideCell(placement.lat, placement.lng, resCollide);
    coin.spawnedAt = Number(nowMs) || Date.now();

    room.state.coins.set(id, coin);
    appendDebugLog("spawn.created", {
      coinId: id,
      value,
      lat: coin.lat,
      lng: coin.lng,
      h3SpawnCell: String(coin.h3SpawnCell ?? ""),
      h3CollideCell: String(coin.h3CollideCell ?? ""),
      activeCoins: Number(room.state.coins.size),
    });
    return true;
  }

  function tick() {
    const nowMs = Date.now();
    try {
      const minActive = Math.max(0, Number(config.minActiveCoins) || 0);
      while (room.state?.coins?.size < minActive) {
        if (!trySpawnOne(nowMs)) break;
      }
      trySpawnOne(nowMs);
    } catch (err) {
      console.error("[coinRoomRuntime] tick:", err?.message ?? err);
    }
  }

  if (config.enabled && room.roomCell) {
    spawnTimer = setInterval(() => tick(), config.spawnIntervalMs);
    if (room.state?.users?.size > 0) {
      setImmediate(() => tick());
    }
  }

  function scheduleDeferredTick() {
    if (!config.enabled || !room.roomCell) return;
    if (deferredTickHandle != null) return;
    deferredTickHandle = setImmediate(() => {
      deferredTickHandle = null;
      tick();
    });
  }

  /**
   * @param {import("@colyseus/core").Client} client
   * @param {*} user
   * @param {string} coinId
   * @param {{ isAutoCollision?: boolean }} [opts] — se true, não envia `collectCoinRejected` (coleta por updatePosition).
   */
  async function executeCoinPickup(client, user, coinId, opts = {}) {
    const isAuto = !!opts.isAutoCollision;
    if (!coinId || !room.state) return;

    if (pickupLocks.has(coinId)) return;
    pickupLocks.add(coinId);

    try {
      const coin = room.state.coins.get(coinId);
      if (!coin) return;
      appendDebugLog("pickup.attempt", {
        coinId,
        userId: String(user?.id ?? ""),
        sessionId: String(client?.sessionId ?? ""),
        auto: isAuto,
        userLat: Number(user?.lat ?? 0),
        userLng: Number(user?.lng ?? 0),
        userCollideCell: latLngToCollideCell(Number(user?.lat), Number(user?.lng), resCollide),
        coinCollideCell: String(coin.h3CollideCell ?? ""),
      });

      if (!user?.id) {
        appendDebugLog("pickup.rejected", {
          coinId,
          sessionId: String(client?.sessionId ?? ""),
          auto: isAuto,
          reason: "no_user",
        });
        if (!isAuto && client?.send) {
          client.send("collectCoinRejected", { coinId, reason: "no_user" });
        }
        return;
      }

      const nowMs = Date.now();
      if (!rateLimiter.tryConsume(client.sessionId, nowMs)) {
        appendDebugLog("pickup.rejected", {
          coinId,
          userId: String(user.id),
          sessionId: String(client?.sessionId ?? ""),
          auto: isAuto,
          reason: "rate_limited",
        });
        if (!isAuto && client?.send) {
          client.send("collectCoinRejected", { coinId, reason: "rate_limited" });
        }
        return;
      }

      const value = Math.max(1, Math.floor(Number(coin.value) || 1));
      const idempotencyKey = `rp:${String(room.roomId)}:${coinId}`;

      let balance = 0;
      let duplicate = false;
      try {
        const result = await applyCoinDelta({
          userId: String(user.id),
          delta: value,
          type: "ROOM_PICKUP",
          idempotencyKey,
          colyseusRoomId: String(room.roomId ?? ""),
          metadata: {
            coinId,
            roomCell: room.roomCell ?? "",
            lat: coin.lat,
            lng: coin.lng,
            pickup: isAuto ? "auto_res_collide" : "manual_collectCoin",
          },
        });
        balance = result.balance;
        duplicate = !!result.duplicate;
      } catch (err) {
        console.error("[coinRoomRuntime] applyCoinDelta:", err?.message ?? err);
        appendDebugLog("pickup.rejected", {
          coinId,
          userId: String(user.id),
          sessionId: String(client?.sessionId ?? ""),
          auto: isAuto,
          reason: "ledger_error",
          error: String(err?.message ?? err),
        });
        if (!isAuto && client?.send) {
          client.send("collectCoinRejected", { coinId, reason: "ledger_error" });
        }
        return;
      }

      room.state.coins.delete(coinId);
      appendDebugLog("pickup.success", {
        coinId,
        userId: String(user.id),
        sessionId: String(client?.sessionId ?? ""),
        auto: isAuto,
        value,
        balance,
        duplicate,
        remainingCoins: Number(room.state.coins.size),
      });

      if (client?.send) {
        client.send("roomCoinGranted", {
          coinId,
          value,
          balance,
          duplicate,
          roomCell: room.roomCell ?? "",
          via: isAuto ? "collision" : "collectCoin",
        });
      }

      room.broadcast("coinCollected", {
        coinId,
        collectedByUserId: String(user.id),
        value,
        via: isAuto ? "collision" : "collectCoin",
      });
    } finally {
      pickupLocks.delete(coinId);
    }
  }

  /**
   * Chamado a cada updatePosition após atualizar lat/lng do usuário.
   */
  async function tryAutoCollectOnPosition(client, user, userCollideCellFromRoom = "") {
    if (!config.enabled || !user?.id || !room.state?.coins) return;
    const userCell =
      String(userCollideCellFromRoom || "") || latLngToCollideCell(Number(user.lat), Number(user.lng), resCollide);
    if (!userCell) return;

    const ids = [];
    room.state.coins.forEach((coin, id) => {
      if (cellsCollideForPickup(userCell, String(coin.h3CollideCell ?? ""))) {
        ids.push(id);
      }
    });

    appendDebugLog("autocollect.scan", {
      userId: String(user.id),
      sessionId: String(client?.sessionId ?? ""),
      userLat: Number(user.lat ?? 0),
      userLng: Number(user.lng ?? 0),
      userCollideCell: String(userCell),
      activeCoins: Number(room.state.coins.size),
      matchingCoinIds: ids,
    });

    for (const coinId of ids) {
      await executeCoinPickup(client, user, coinId, { isAutoCollision: true });
    }
  }

  function debugLogPositionSnapshot(client, user, userCollideCell) {
    const sessionId = String(client?.sessionId ?? "");
    const now = Date.now();
    const last = Number(lastPositionLogBySession.get(sessionId) ?? 0);
    if (now - last < 1500) return;
    lastPositionLogBySession.set(sessionId, now);

    const sampleCoins = [];
    let i = 0;
    room.state?.coins?.forEach((coin, id) => {
      if (i >= 8) return;
      sampleCoins.push({
        id,
        h3CollideCell: String(coin.h3CollideCell ?? ""),
        lat: Number(coin.lat ?? 0),
        lng: Number(coin.lng ?? 0),
      });
      i += 1;
    });

    appendDebugLog("position.snapshot", {
      userId: String(user?.id ?? ""),
      sessionId,
      userLat: Number(user?.lat ?? 0),
      userLng: Number(user?.lng ?? 0),
      userCollideCell: String(userCollideCell ?? ""),
      activeCoins: Number(room.state?.coins?.size ?? 0),
      sampleCoins,
    });
  }

  return {
    dispose() {
      if (spawnTimer != null) {
        clearInterval(spawnTimer);
      }
      spawnTimer = null;
      if (deferredTickHandle != null) {
        clearImmediate(deferredTickHandle);
        deferredTickHandle = null;
      }
      pickupLocks.clear();
      lastPositionLogBySession.clear();
    },

    scheduleDeferredTick,

    tryAutoCollectOnPosition,
    debugLogPositionSnapshot,

    async handleCollectCoin(client, data) {
      const coinId = String(data?.coinId ?? "").trim();
      if (!coinId || !client?.sessionId || !room.state) {
        return;
      }

      const user = room.state.users.get(client.sessionId);
      if (!user?.id) {
        client.send("collectCoinRejected", { coinId, reason: "no_user" });
        return;
      }

      const coin = room.state.coins.get(coinId);
      if (!coin) {
        client.send("collectCoinRejected", { coinId, reason: "not_found" });
        return;
      }

      const userCell = latLngToCollideCell(Number(user.lat), Number(user.lng), resCollide);
      if (!cellsCollideForPickup(userCell, String(coin.h3CollideCell ?? ""))) {
        client.send("collectCoinRejected", { coinId, reason: "no_collision" });
        return;
      }

      await executeCoinPickup(client, user, coinId, { isAutoCollision: false });
    },

    _debugTick: tick,
  };
}

module.exports = {
  attachCoinRoomRuntime,
};
