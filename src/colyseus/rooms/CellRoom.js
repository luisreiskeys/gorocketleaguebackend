/**
 * Sala por célula H3.
 * IMPORTANTE: troca de sala usando HANDOFF para evitar "buraco" (momento sem sala).
 */
const { Room } = require("colyseus");
const { cellToParent, latLngToCell } = require("h3-js");
const { resRoomCell, resCollide } = require("../../config/h3Resolutions");
const { CellState } = require("../state/CellState");
const { UserState } = require("../state/UserState");
const { prisma } = require("../../db/prisma");
const { logJoin } = require("../cellRoomJoinLogger");
const roomRegistry = require("../roomRegistry");
const { attachCoinRoomRuntime } = require("../coins/coinRoomRuntime");
const { computeFuel, clampFuel } = require("../../rules/fuelRules");
const { computeDistanceXp, computeOwnershipXp } = require("../../rules/xpRules");
const { claimAdReward } = require("../../services/adRewardService");
const { ensureWallet } = require("../../services/coinService");
const { purchaseFuelWithCoins, FuelPurchaseError } = require("../../services/fuelPurchaseService");
const { getFuelEconomyConfig } = require("../../config/fuelEconomyConfig");
const { getCardSpawnConfig } = require("../../config/cardSpawnConfig");
const { CardState } = require("../state/CardState");
const { grantEligiblePacks } = require("../../services/cardPackService");
const { getSerialClass } = require("../../services/cardInstanceMintService");
const { incrementPlayerFoundProgress } = require("../../services/playerProgressService");
const {
  claimWorldPoolInstancesForRoom,
  releaseRoomReservedInstances,
  getRoomActiveInstancesMax,
} = require("../../services/cellRoomCardService");
const { latLngToCollideCell, cellsCollideForPickup } = require("../../rules/coinCollisionRules");
const {
  captureOwnershipDominant,
  checkAndCompactUpward,
  getDominantOwnershipRecord,
  getCellCenterLatLng,
  getUserOwnershipStats,
} = require("../../utils/cellOwnership");

function parsePositiveInt(envKey, fallback) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DEFAULT_MAX_FUEL = parsePositiveInt("DEFAULT_MAX_FUEL", 100);
const DEFAULT_REFILL_INTERVAL_MS = parsePositiveInt("DEFAULT_REFILL_INTERVAL_MS", 300000);
const runtimeFuelStateByUserId = new Map();
const ENABLE_TIME_REFILL = String(process.env.ENABLE_TIME_REFILL ?? "false").toLowerCase() === "true";

function getFuelPolicyForUser(_user) {
  // Futuro: personalizar por usuário/plano/modificador.
  return {
    maxFuel: DEFAULT_MAX_FUEL,
    refillInterval: DEFAULT_REFILL_INTERVAL_MS,
    refillAmount: DEFAULT_MAX_FUEL,
  };
}

function persistUser(userId, data) {
  if (!userId) return Promise.resolve();
  return prisma.user
    .update({ where: { id: userId }, data })
    .catch((err) => console.error("[CellRoom] persistUser DB:", err.message));
}

class CellRoom extends Room {
  async _loadRoomCardsFromDb() {
    if (!this.roomCell || !this.state?.cards || !this.roomId) return;
    try {
      const rows = await prisma.instance.findMany({
        where: {
          h3RoomCell: this.roomCell,
          reservedByRoomId: String(this.roomId),
          ownerId: null,
          foundWhen: null,
        },
        select: {
          id: true,
          cardId: true,
          serialNumber: true,
          serialMax: true,
          latitude: true,
          longitude: true,
          h3RoomCell: true,
          spawnSource: true,
          spawnedAt: true,
          card: {
            select: {
              name: true,
              ovr: true,
              url: true,
            },
          },
        },
        take: Math.min(20, Math.max(4, getRoomActiveInstancesMax() + 2)),
        orderBy: { spawnedAt: "desc" },
      });
      this.state.cards.clear();
      for (const row of rows) {
        const card = new CardState();
        card.id = String(row.id);
        card.cardId = Number(row.cardId);
        card.name = String(row.card?.name ?? "");
        card.ovr = Number(row.card?.ovr ?? 0);
        card.url = String(row.card?.url ?? "");
        card.serialNumber = Number(row.serialNumber ?? 0);
        card.serialMax = Number(row.serialMax ?? 0);
        card.serialClass = getSerialClass(card.serialNumber, card.serialMax);
        card.lat = Number(row.latitude ?? 0);
        card.lng = Number(row.longitude ?? 0);
        card.h3RoomCell = String(row.h3RoomCell ?? "");
        card.spawnSource = String(row.spawnSource ?? "");
        card.h3CollideCell = latLngToCollideCell(Number(row.latitude), Number(row.longitude), resCollide);
        card.spawnedAt = Number(new Date(row.spawnedAt).getTime());
        this.state.cards.set(card.id, card);
      }
    } catch (err) {
      console.error("[CellRoom] _loadRoomCardsFromDb:", err?.message ?? err);
    }
  }

  /**
   * Coleta autoritativa (DB + state). `isAutoCollision` evita spam de collectCardRejected (igual coins).
   * @returns {Promise<boolean>} true se a instancia foi atribuida ao usuario
   */
  async _executeRoomCardPickup(client, user, cardInstanceId, opts = {}) {
    const isAuto = !!opts.isAutoCollision;
    if (!cardInstanceId || !user?.id) return false;

    if (!this._cardPickupLocks) this._cardPickupLocks = new Set();
    if (this._cardPickupLocks.has(cardInstanceId)) return false;
    this._cardPickupLocks.add(cardInstanceId);

    try {
      const claimed = await prisma.$transaction(async (tx) => {
        const target = await tx.instance.findUnique({
          where: { id: String(cardInstanceId) },
          select: { id: true, cardId: true },
        });
        if (!target) return { count: 0 };

        const updated = await tx.instance.updateMany({
          where: {
            id: String(cardInstanceId),
            reservedByRoomId: String(this.roomId),
            ownerId: null,
            foundWhen: null,
          },
          data: {
            ownerId: String(user.id),
            reservedByRoomId: null,
            foundWhen: new Date(),
            foundWhereLat: Number(user.lat ?? 0),
            foundWhereLng: Number(user.lng ?? 0),
          },
        });
        if (updated.count > 0) {
          await incrementPlayerFoundProgress(tx, target.cardId, 1);
        }
        return updated;
      });
      if (!claimed.count) {
        if (!isAuto && client?.send) {
          client.send("collectCardRejected", {
            cardInstanceId: String(cardInstanceId),
            reason: "not_available",
          });
        }
        return false;
      }
      this.state.cards.delete(String(cardInstanceId));
      const via = isAuto ? "collision" : "collectCard";
      if (client?.send) {
        client.send("roomCardGranted", {
          cardInstanceId: String(cardInstanceId),
          userId: String(user.id),
          via,
        });
      }
      this.broadcast("roomCardCollected", {
        cardInstanceId: String(cardInstanceId),
        collectedByUserId: String(user.id),
        via,
      });

      this._scheduleCardRoomRefillAfterCooldown();
      return true;
    } catch (err) {
      console.error("[CellRoom] _executeRoomCardPickup:", err?.message ?? err);
      if (!isAuto && client?.send) {
        client.send("collectCardRejected", {
          cardInstanceId: String(cardInstanceId),
          reason: "server_error",
        });
      }
      return false;
    } finally {
      this._cardPickupLocks.delete(cardInstanceId);
    }
  }

  async tryAutoCollectCardsOnPosition(client, user, userCollideCellFromRoom = "") {
    if (!this.state?.cards?.size || !user?.id) return;

    const minInterval = getCardSpawnConfig().cardAutoPickupMinIntervalMs;
    const last = Number(user._lastAutoCardPickupAt ?? 0);
    if (last > 0 && Date.now() - last < minInterval) return;

    const userCell =
      String(userCollideCellFromRoom || "") ||
      latLngToCollideCell(Number(user.lat), Number(user.lng), resCollide);
    if (!userCell) return;

    const ids = [];
    this.state.cards.forEach((card, id) => {
      if (cellsCollideForPickup(userCell, String(card.h3CollideCell ?? ""))) {
        ids.push(id);
      }
    });

    // Todas as cartas no mapa usam o mesmo centro de celula -> mesmo h3CollideCell: coletar uma por vez.
    if (ids.length === 0) return;
    const cardInstanceId = ids[0];

    const ok = await this._executeRoomCardPickup(client, user, cardInstanceId, { isAutoCollision: true });
    if (ok) {
      user._lastAutoCardPickupAt = Date.now();
    }
  }

  async _collectRoomCard(client, cardInstanceId) {
    const user = this.state.users.get(client.sessionId);
    if (!user?.id) {
      client.send("collectCardRejected", { reason: "no_user" });
      return;
    }
    if (!cardInstanceId) return;

    const card = this.state.cards.get(String(cardInstanceId));
    if (!card) {
      client.send("collectCardRejected", {
        cardInstanceId: String(cardInstanceId),
        reason: "not_found",
      });
      return;
    }

    const userCell = latLngToCollideCell(Number(user.lat), Number(user.lng), resCollide);
    if (!cellsCollideForPickup(userCell, String(card.h3CollideCell ?? ""))) {
      client.send("collectCardRejected", {
        cardInstanceId: String(cardInstanceId),
        reason: "no_collision",
      });
      return;
    }

    await this._executeRoomCardPickup(client, user, cardInstanceId, { isAutoCollision: false });
  }

  /**
   * Repoe cartas do pool somente apos CARD_ROOM_REFILL_COOLDOWN_MS da ultima coleta (nao imediato).
   */
  _scheduleCardRoomRefillAfterCooldown() {
    if (this._cardRefillCooldownTimer) {
      clearTimeout(this._cardRefillCooldownTimer);
      this._cardRefillCooldownTimer = null;
    }
    const ms = getCardSpawnConfig().roomCardRefillCooldownMs;
    this._cardRefillCooldownTimer = setTimeout(() => {
      this._cardRefillCooldownTimer = null;
      void this._refillRoomCardsFromPoolIfNeeded()?.catch((e) =>
        console.error("[CellRoom] _refillRoomCardsFromPoolIfNeeded:", e?.message ?? e),
      );
    }, ms);
  }

  /**
   * Mantem no maximo CARD_ROOM_ACTIVE_INSTANCES_MAX cartas reservadas nesta sala (repoe do pool apos coleta).
   */
  async _refillRoomCardsFromPoolIfNeeded() {
    if (!this.roomCell || !this.roomId || !this.state?.cards) return;

    const max = getRoomActiveInstancesMax();
    const current = this.state.cards.size;
    if (current >= max) return;

    const need = max - current;
    if (need <= 0) return;

    await claimWorldPoolInstancesForRoom({
      roomId: String(this.roomId),
      roomCell: this.roomCell,
      targetCount: need,
    });
    await this._loadRoomCardsFromDb();
  }

  _saveRuntimeFuelState(user) {
    if (!user?.id) return;
    runtimeFuelStateByUserId.set(String(user.id), {
      fuel: Number(user.fuel ?? 0),
      maxFuel: Number(user.maxFuel ?? DEFAULT_MAX_FUEL),
      refillInterval: Number(user.refillInterval ?? DEFAULT_REFILL_INTERVAL_MS),
      lastRefillAt: Number(user.lastRefillAt ?? 0),
      lastFuelUpdateAt: Number(user.lastFuelUpdateAt ?? Date.now()),
      refillActive: !!user.refillActive,
      refillGranted: Number(user.refillGranted ?? 0),
      xpDistanceKmRemainder: Number(user._xpDistanceKmRemainder ?? 0),
    });
  }

  _restoreRuntimeFuelState(user) {
    if (!user?.id) return false;
    const saved = runtimeFuelStateByUserId.get(String(user.id));
    if (!saved) return false;
    user.fuel = Number(saved.fuel ?? user.fuel ?? 0);
    user.maxFuel = Number(saved.maxFuel ?? user.maxFuel ?? DEFAULT_MAX_FUEL);
    user.refillInterval = Number(saved.refillInterval ?? user.refillInterval ?? DEFAULT_REFILL_INTERVAL_MS);
    user.lastRefillAt = Number(saved.lastRefillAt ?? user.lastRefillAt ?? 0);
    user.lastFuelUpdateAt = Number(saved.lastFuelUpdateAt ?? user.lastFuelUpdateAt ?? Date.now());
    user.refillActive = !!saved.refillActive;
    user.refillGranted = Number(saved.refillGranted ?? user.refillGranted ?? 0);
    user._xpDistanceKmRemainder = Number(saved.xpDistanceKmRemainder ?? user._xpDistanceKmRemainder ?? 0);
    return true;
  }

  _getUserFuelPolicy(user) {
    const policy = getFuelPolicyForUser(user);
    return {
      maxFuel: Number(policy.maxFuel ?? DEFAULT_MAX_FUEL),
      refillInterval: Number(policy.refillInterval ?? DEFAULT_REFILL_INTERVAL_MS),
      refillAmount: Number(policy.refillAmount ?? DEFAULT_MAX_FUEL),
    };
  }

  _ensureFuelState(user, nowMs) {
    const { maxFuel, refillInterval } = this._getUserFuelPolicy(user);
    user.maxFuel = maxFuel;
    user.refillInterval = refillInterval;
    user.fuel = clampFuel(Number(user.fuel ?? 0), maxFuel);
    if (!Number.isFinite(user.lastFuelUpdateAt) || user.lastFuelUpdateAt <= 0) {
      user.lastFuelUpdateAt = nowMs;
    }
    if (!Number.isFinite(user.lastRefillAt) || user.lastRefillAt < 0) {
      user.lastRefillAt = 0;
    }
    if (!Number.isFinite(user.refillGranted) || user.refillGranted < 0) {
      user.refillGranted = 0;
    }
    if (typeof user.refillActive !== "boolean") {
      user.refillActive = false;
    }
  }

  _startRefillCycle(user, nowMs) {
    this._ensureFuelState(user, nowMs);
    user.refillActive = true;
    user.refillGranted = 0;
    user.lastRefillAt = nowMs;
    user.lastFuelUpdateAt = nowMs;
  }

  _applyFuelRefillByTime(user, nowMs) {
    if (!ENABLE_TIME_REFILL) {
      this._ensureFuelState(user, nowMs);
      user.lastFuelUpdateAt = nowMs;
      return;
    }
    this._ensureFuelState(user, nowMs);
    const elapsed = Math.max(0, nowMs - Number(user.lastFuelUpdateAt || nowMs));
    if (elapsed <= 0) return;

    // Sem ciclo ativo, não injeta combustível por tempo.
    if (!user.refillActive) {
      user.lastFuelUpdateAt = nowMs;
      return;
    }

    const { refillInterval, refillAmount } = this._getUserFuelPolicy(user);
    const remainingBudget = Math.max(0, Number(refillAmount) - Number(user.refillGranted || 0));
    if (remainingBudget > 0) {
      const refillPerMs = Number(refillAmount) / Number(refillInterval || DEFAULT_REFILL_INTERVAL_MS);
      const injected = Math.min(remainingBudget, refillPerMs * elapsed);
      user.fuel = clampFuel(Number(user.fuel) + injected, Number(user.maxFuel));
      user.refillGranted = Number(user.refillGranted || 0) + injected;
    }

    // Encerramos o ciclo ao consumir todo orçamento de recarga.
    if (Number(user.refillGranted || 0) >= Number(refillAmount) - 1e-6) {
      user.refillActive = false;
      user.refillGranted = Number(refillAmount);
    }
    user.lastFuelUpdateAt = nowMs;
  }

  _notifyFuelDepleted(client, user) {
    if (!client || !user) return;
    if (user._fuelEmptyNotified) return;
    const { maxFuel, refillInterval } = this._getUserFuelPolicy(user);
    const lastRefillAt = Number(user.lastRefillAt || Date.now());
    user.lastRefillAt = lastRefillAt;
    user._fuelEmptyNotified = true;
    client.send("fuelDepleted", {
      fuel: 0,
      maxFuel,
      refillInterval,
      lastRefillAt,
    });
  }

  _clearFuelDepletedIfRecovered(user) {
    if (!user) return;
    if (Number(user.fuel ?? 0) > 0) {
      user._fuelEmptyNotified = false;
    }
  }

  async _captureCellForUser(userId) {
    if (!userId || !this.roomCell) return false;
    if (this._captureInProgress) return false;
    this._captureInProgress = true;
    try {
      const wasCaptured = !!this.state.flag?.isCaptured;
      const previousOwnerUserId = String(this.state.owner?.userId ?? "");
      const captureResult = await captureOwnershipDominant(prisma, {
        h3Index: this.roomCell,
        startResolution: resRoomCell,
        userId,
      });

      await checkAndCompactUpward(prisma, {
        h3Index: captureResult.h3Index,
        resolution: captureResult.resolution,
        userId,
        maxSteps: 6,
      });

      const dominantAfter = await getDominantOwnershipRecord(prisma, {
        h3Index: this.roomCell,
        startResolution: resRoomCell,
        maxSteps: 12,
      });

      if (dominantAfter?.ownerUserId) {
        this.state.owner.userId = String(dominantAfter.ownerUserId);
        this.state.flag.isCaptured = true;
      } else {
        this.state.owner.userId = "";
        this.state.flag.isCaptured = false;
      }

      const capturedByRequesterNow =
        !wasCaptured && String(this.state.owner.userId ?? "") === String(userId) && previousOwnerUserId !== String(userId);
      if (capturedByRequesterNow) {
        this.state.users.forEach((u) => {
          if (String(u.id) === String(userId)) {
            u.xp = Math.floor(Number(u.xp ?? 0)) + computeOwnershipXp(1);
          }
        });
      }

      // Atualiza estatísticas do usuário que capturou, se ele ainda estiver nesta sala.
      try {
        const stats = await getUserOwnershipStats(prisma, userId, resRoomCell);
        this.state.users.forEach((u) => {
          if (String(u.id) === String(userId)) {
            u.flagsOwned = stats.flagsOwned;
            u.ownedAreaKm2 = stats.ownedAreaKm2;
          }
        });
      } catch (e) {
        console.error("[CellRoom] getUserOwnershipStats error:", e?.message ?? e);
      }

      this.broadcast("flagCaptured", {
        h3RoomCell: this.roomCell ?? "",
        capturedByUserId: userId,
        ownerUserId: this.state.owner.userId,
      });
      return true;
    } catch (err) {
      console.error("[CellRoom] capture error:", err?.message ?? err);
      return false;
    } finally {
      this._captureInProgress = false;
    }
  }

  async onCreate(options) {
    try {
      console.log("[CellRoom] onCreate", options?.h3RoomCell);
      this._cardPickupLocks = new Set();
      this._cardRefillCooldownTimer = null;
      this.setState(new CellState());
      this.roomCell = options.h3RoomCell || null;
      roomRegistry.add(this);

      const roomEconomy = getFuelEconomyConfig(this.roomCell);
      this.state.economy.maxFuel = roomEconomy.maxFuel;
      this.state.economy.fuelPurchaseCoinsPerPercent = roomEconomy.fuelPurchaseCoinsPerPercent;

      if (this.roomCell) {
        const center = getCellCenterLatLng(this.roomCell);
        this._roomCellCenterLat = center.lat;
        this._roomCellCenterLng = center.lng;
        this.state.flag.lat = center.lat;
        this.state.flag.lng = center.lng;
        this.state.flag.isCaptured = false;
        this.state.owner.userId = "";
        this.flagCollideCell = latLngToCell(center.lat, center.lng, resCollide);

        const dominant = await getDominantOwnershipRecord(prisma, {
          h3Index: this.roomCell,
          startResolution: resRoomCell,
          maxSteps: 12,
        });

        if (dominant?.ownerUserId) {
          this.state.owner.userId = String(dominant.ownerUserId);
          this.state.flag.isCaptured = true;
        }

        if (this.roomId) {
          try {
            await claimWorldPoolInstancesForRoom({
              roomId: String(this.roomId),
              roomCell: this.roomCell,
              targetCount: getRoomActiveInstancesMax(),
            });
          } catch (e) {
            console.error("[CellRoom] claimWorldPoolInstancesForRoom:", e?.message ?? e);
          }
        }

        await this._loadRoomCardsFromDb();
      }
    } catch (err) {
      console.error("[CellRoom] onCreate error:", err);
      throw err;
    }

    /**
     * O client avisa quando já entrou na nova sala com sucesso.
     * Aí sim removemos o user do state desta sala.
     */
    this.onMessage("switchedRoom", (client, data) => {
      const handoffId = String(data?.handoffId ?? "");
      const user = this.state.users.get(client.sessionId);
      if (!user) return;

      // Só finaliza se bate com o handoff que a sala pediu
      if (user._pendingHandoffId && user._pendingHandoffId === handoffId) {
        this._saveRuntimeFuelState(user);
        // remove da sala antiga (estado local)
        this.state.users.delete(client.sessionId);

        // opcional: desconectar da sala antiga (agora é seguro)
        try {
          client.leave(1000);
        } catch {}

        // limpa flags (não é necessário pois já removemos do state)
      }
    });

    this.onMessage("captureCell", async (client) => {
      const user = this.state.users.get(client.sessionId);
      if (!user?.id || !this.roomCell) return;
      await this._captureCellForUser(user.id);
    });

    this.onMessage("updatePosition", (client, data) => {
      const user = this.state.users.get(client.sessionId);
      if (!user) return;

      // Se já está em processo de troca, ignore updates aqui (evita duplicidade)
      if (user._switching) return;

      user.lat = data.lat;
      user.lng = data.lng;
      user.h3UserCell = data.h3UserCell ?? data.h3Res9 ?? user.h3UserCell ?? "";
      user.deltaKm = Number(data.deltaKm ?? 0);
      if (!Number.isFinite(user._xpDistanceKmRemainder) || user._xpDistanceKmRemainder < 0) {
        user._xpDistanceKmRemainder = 0;
      }
      const nowMs = Date.now();
      this._applyFuelRefillByTime(user, nowMs);

      // Fuel enviado pelo cliente é somente informativo (server é autoritativo).
      const clientFuel = Number(data.fuel);
      if (Number.isFinite(clientFuel)) {
        const drift = Math.abs(clientFuel - Number(user.fuel ?? 0));
        if (drift > 0.5) {
          console.warn("[CellRoom] client fuel drift ignored", {
            userId: user.id,
            clientFuel,
            serverFuel: user.fuel,
            drift,
          });
        }
      }

      if (user.deltaKm > 0) {
        user.fuel = computeFuel(user, Number(user.maxFuel ?? DEFAULT_MAX_FUEL));
        const distanceXp = computeDistanceXp(user.deltaKm, user._xpDistanceKmRemainder);
        user._xpDistanceKmRemainder = distanceXp.remainderKm;
        if (distanceXp.xpGained > 0) {
          user.xp = Math.floor(Number(user.xp ?? 0)) + distanceXp.xpGained;
        }
      }

      if (Number(user.fuel ?? 0) <= 0) {
        user.fuel = 0;
        if (ENABLE_TIME_REFILL && !user.refillActive) {
          this._startRefillCycle(user, nowMs);
        }
        this._notifyFuelDepleted(client, user);
      } else {
        this._clearFuelDepletedIfRecovered(user);
      }
      this._saveRuntimeFuelState(user);

      const userCollideCell = latLngToCell(user.lat, user.lng, resCollide);
      this._coinRuntime?.debugLogPositionSnapshot?.(client, user, userCollideCell);

      // Captura automática por colisão: mesma célula em resCollide da flag central.
      if (!this.state.flag.isCaptured && this.flagCollideCell && user.id) {
        if (userCollideCell === this.flagCollideCell) {
          // Não depende de mensagem nova do mobile; backend captura sozinho.
          this._captureCellForUser(user.id);
        }
      }

      // Coins: mesma regra H3_RES_COLLIDE que a flag — crédito + roomCoinGranted + coinCollected.
      void this._coinRuntime
        ?.tryAutoCollectOnPosition?.(client, user, userCollideCell)
        ?.catch((err) => console.error("[CellRoom] tryAutoCollectOnPosition:", err?.message ?? err));

      // Cartas: mesma célula H3_RES_COLLIDE — roomCardGranted + roomCardCollected (via collision).
      void this.tryAutoCollectCardsOnPosition(client, user, userCollideCell)?.catch((err) =>
        console.error("[CellRoom] tryAutoCollectCardsOnPosition:", err?.message ?? err),
      );

      const roomCellFromUser = user.h3UserCell ? cellToParent(user.h3UserCell, resRoomCell) : "";

      if (roomCellFromUser && roomCellFromUser !== this.roomCell) {
        // Marca que está trocando
        user._switching = true;

        const handoffId = `${client.sessionId}:${Date.now()}`;
        user._pendingHandoffId = handoffId;

        // Persistência sem await (não trava a troca)
        if (user.id) {
          persistUser(user.id, {
            lat: user.lat,
            lng: user.lng,
            h3UserCell: user.h3UserCell ?? "",
            h3RoomCell: roomCellFromUser,
            fuel: user.fuel,
            xp: user.xp,
            level: user.level,
            coverage: user.coverage,
          });
        }

        // Envia ordem de troca para o client (sem expulsar agora)
        client.send("changeRoom", {
          handoffId,
          newRoom: `cell:${roomCellFromUser}`,
          // manda snapshot mínimo para debug/sync (opcional)
          fuel: user.fuel,
          lat: user.lat,
          lng: user.lng,
          h3UserCell: user.h3UserCell ?? "",
          xp: user.xp,
          level: user.level,
          coverage: user.coverage,
        });

        // NÃO dá leave aqui. A sala antiga só finaliza no "switchedRoom".
      }
    });

    this.onMessage("updateStats", (client, data) => {
      const user = this.state.users.get(client.sessionId);
      if (!user) return;
      const nowMs = Date.now();
      this._applyFuelRefillByTime(user, nowMs);
      // XP é autoritativo no backend (distance/ownership rules).
      user.level = data.level;
      // Fuel é autoritativo no backend: ignoramos o valor enviado pelo cliente.
      if (data.coverage !== undefined) user.coverage = data.coverage;

      if (Number(user.fuel ?? 0) <= 0) {
        user.fuel = 0;
        if (ENABLE_TIME_REFILL && !user.refillActive) {
          this._startRefillCycle(user, nowMs);
        }
        this._notifyFuelDepleted(client, user);
      } else {
        this._clearFuelDepletedIfRecovered(user);
      }
      this._saveRuntimeFuelState(user);
    });

    this.onMessage("collectCoin", async (client, data) => {
      try {
        await this._coinRuntime?.handleCollectCoin?.(client, data);
      } catch (err) {
        console.error("[CellRoom] collectCoin error:", err?.message ?? err);
      }
    });

    this.onMessage("collectCard", async (client, data) => {
      const cardInstanceId = String(data?.cardInstanceId ?? data?.instanceId ?? "").trim();
      if (!cardInstanceId) {
        client.send("collectCardRejected", { reason: "invalid_card_id" });
        return;
      }
      await this._collectRoomCard(client, cardInstanceId);
    });

    this.onMessage("claimAdReward", async (client, data) => {
      const user = this.state.users.get(client.sessionId);
      const clientRewardToken = String(data?.clientRewardToken ?? data?.rewardToken ?? data?.token ?? "").trim();
      if (!user?.id) {
        client.send("adRewardRejected", { reason: "no_user" });
        return;
      }
      if (!clientRewardToken) {
        client.send("adRewardRejected", { reason: "invalid_token" });
        return;
      }
      try {
        await ensureWallet(String(user.id));
        const result = await claimAdReward({
          userId: String(user.id),
          clientRewardToken,
          rewardUnitId: data?.rewardUnitId ?? data?.adUnitId ?? null,
          colyseusRoomId: String(this.roomId ?? ""),
          amountOverride: data?.amount,
        });
        client.send("adRewardGranted", {
          balance: result.balance,
          amount: result.amount,
          duplicate: result.duplicate,
        });
      } catch (err) {
        const code = err?.code;
        if (code === "RATE_LIMITED") {
          client.send("adRewardRejected", { reason: "rate_limited" });
          return;
        }
        if (code === "INVALID_TOKEN") {
          client.send("adRewardRejected", { reason: "invalid_token" });
          return;
        }
        console.error("[CellRoom] claimAdReward error:", err?.message ?? err);
        client.send("adRewardRejected", { reason: "server_error" });
      }
    });

    this.onMessage("purchaseFuel", async (client, data) => {
      const user = this.state.users.get(client.sessionId);
      if (!user?.id) {
        client.send("fuelPurchaseRejected", { reason: "no_user" });
        return;
      }
      const idempotencyKey = data?.idempotencyKey ?? data?.idempotency_key ?? null;
      if (idempotencyKey != null && String(idempotencyKey).trim() !== "") {
        const k = String(idempotencyKey).trim();
        if (k.length < 8 || k.length > 256) {
          client.send("fuelPurchaseRejected", { reason: "invalid_idempotency" });
          return;
        }
      }
      const percentToAddRaw = data?.percentToAdd ?? data?.percent_to_add;
      const percentToAdd =
        percentToAddRaw !== undefined && percentToAddRaw !== null && percentToAddRaw !== ""
          ? Number(percentToAddRaw)
          : undefined;

      try {
        await ensureWallet(String(user.id));
        const result = await purchaseFuelWithCoins({
          userId: String(user.id),
          idempotencyKey,
          colyseusRoomId: String(this.roomId ?? ""),
          roomCell: this.roomCell ?? null,
          percentToAdd,
        });
        this.state.users.forEach((u) => {
          if (String(u.id) === String(user.id)) {
            u.fuel = result.fuel;
            this._clearFuelDepletedIfRecovered(u);
            this._saveRuntimeFuelState(u);
          }
        });
        persistUser(String(user.id), { fuel: result.fuel }).catch((e) =>
          console.error("[CellRoom] purchaseFuel persistUser:", e?.message ?? e),
        );
        client.send("fuelPurchaseGranted", {
          balance: result.balance,
          fuel: result.fuel,
          maxFuel: result.maxFuel,
          coinsSpent: result.coinsSpent,
          percentMissing: result.percentMissing,
          percentPurchased: result.percentPurchased,
          duplicate: result.duplicate,
        });
      } catch (err) {
        if (err instanceof FuelPurchaseError) {
          const map = {
            ALREADY_FULL: "already_full",
            INSUFFICIENT_COINS: "insufficient_coins",
            INVALID_IDEMPOTENCY_KEY: "invalid_idempotency",
            INVALID_PERCENT: "invalid_percent",
            USER_NOT_FOUND: "user_not_found",
          };
          const reason = map[err.code] || "server_error";
          client.send("fuelPurchaseRejected", { reason });
          return;
        }
        console.error("[CellRoom] purchaseFuel error:", err?.message ?? err);
        client.send("fuelPurchaseRejected", { reason: "server_error" });
      }
    });

    this._coinRuntime = attachCoinRoomRuntime(this);
  }

  async onJoin(client, options) {
    try {
      console.log("[CellRoom] onJoin", client.sessionId, options?.userId);
    } catch {}

    const joiningUserId = options.userId;
    if (joiningUserId) {
      // remove instâncias antigas do mesmo userId na mesma sala
      const toRemove = [];
      this.state.users.forEach((u, sessionId) => {
        if (String(u.id) === String(joiningUserId) && sessionId !== client.sessionId) {
          toRemove.push(sessionId);
        }
      });
      for (const oldSessionId of toRemove) {
        this.state.users.delete(oldSessionId);
        const oldClient =
          typeof this.clients.getById === "function"
            ? this.clients.getById(oldSessionId)
            : Array.from(this.clients || []).find((c) => c.sessionId === oldSessionId);
        if (oldClient) {
          try {
            oldClient.leave(1000);
          } catch {}
          console.log("[CellRoom] mesma sala: removida instância anterior do userId", joiningUserId, "sessionId", oldSessionId);
        }
      }
    }

    const existingUsers = [];
    this.state.users.forEach((u, sessionId) => {
      existingUsers.push({
        userId: u.id,
        sessionId,
        userCell: u.h3UserCell ?? "",
      });
    });

    let dbUser = null;
    if (options.userId) {
      try {
        dbUser = await prisma.user.findUnique({
          where: { id: options.userId },
          select: {
            username: true,
            avatarId: true,
            level: true,
            xp: true,
            fuel: true,
            coverage: true,
            lat: true,
            lng: true,
            h3UserCell: true,
            firstPack: true,
            lastFreePack: true,
          },
        });
      } catch (err) {
        console.error("[CellRoom] onJoin DB load error:", err?.message ?? err);
      }
    }

    const user = new UserState();
    user.id = options.userId;
    user.username = dbUser?.username ?? options.username ?? "";
    user.avatarId = String(dbUser?.avatarId ?? options.avatarId ?? "");

    user.level = dbUser?.level ?? options.level ?? 1;
    user.xp = dbUser?.xp ?? options.xp ?? 0;
    user.fuel = dbUser?.fuel ?? options.fuel ?? 100;
    user.coverage = dbUser?.coverage ?? options.coverage ?? 0;
    const nowMs = Date.now();
    const policy = this._getUserFuelPolicy(user);
    user.maxFuel = policy.maxFuel;
    user.refillInterval = policy.refillInterval;
    user.lastFuelUpdateAt = nowMs;
    user.lastRefillAt = 0;
    user.refillActive = false;
    user.refillGranted = 0;
    // Se usuário já tinha estado de combustível em runtime (troca de sala),
    // reaplica para não resetar ciclo/Granted a cada handoff.
    this._restoreRuntimeFuelState(user);

    user.lat = dbUser?.lat ?? options.lat ?? 0;
    user.lng = dbUser?.lng ?? options.lng ?? 0;
    user.h3UserCell = dbUser?.h3UserCell ?? options.h3UserCell ?? "";

    // Inicializa stats de território; serão atualizadas async abaixo.
    user.flagsOwned = 0;
    user.ownedAreaKm2 = 0;

    // flags internas (não precisam estar no schema, mas se UserState é Schema,
    // você pode usar propriedades não tipadas; se quiser perfeito, não sincronize.
    user._switching = false;
    user._pendingHandoffId = "";
    user._fuelEmptyNotified = false;
    user._xpDistanceKmRemainder = 0;

    this.state.users.set(client.sessionId, user);

    if (options.userId) {
      try {
        const granted = await grantEligiblePacks(String(options.userId));
        if (granted.grantedInitial) {
          client.send("cardsPackGranted", {
            type: "initial",
            count: granted.initialCards.length,
            cards: granted.initialCards,
          });
        }
        if (granted.grantedDaily) {
          client.send("cardsPackGranted", {
            type: "daily",
            count: granted.dailyCards.length,
            cards: granted.dailyCards,
          });
        }
      } catch (err) {
        console.error("[CellRoom] grantEligiblePacks:", err?.message ?? err);
      }
    }

    // Primeiro jogador na sala: dispara spawn de coins sem esperar o 1º tick do intervalo.
    if (this.state.users.size === 1) {
      try {
        this._coinRuntime?.scheduleDeferredTick?.();
      } catch {}
    }

    // Garante notificação mesmo em troca de sala/reconexão.
    if (Number(user.fuel ?? 0) <= 0) {
      user.fuel = 0;
      if (ENABLE_TIME_REFILL && !user.refillActive) {
        this._startRefillCycle(user, nowMs);
      }
      this._notifyFuelDepleted(client, user);
    }

    // Busca estatísticas de território para este usuário (não bloqueia o join).
    if (options.userId) {
      getUserOwnershipStats(prisma, options.userId, resRoomCell)
        .then((stats) => {
          const current = this.state.users.get(client.sessionId);
          if (!current) return;
          current.flagsOwned = stats.flagsOwned;
          current.ownedAreaKm2 = stats.ownedAreaKm2;
        })
        .catch((e) => console.error("[CellRoom] getUserOwnershipStats(onJoin) error:", e?.message ?? e));
    }

    const roomCellFromClient = options.h3RoomCell ?? "";
    const roomCellFromUserCell = user.h3UserCell ? cellToParent(user.h3UserCell, resRoomCell) : "";
    const roomCell = roomCellFromClient || roomCellFromUserCell;

    if (roomCellFromUserCell && roomCellFromClient && roomCellFromUserCell !== roomCellFromClient) {
      console.warn("[CellRoom] roomCell inconsistente: client enviou", roomCellFromClient, "parent(h3UserCell)=", roomCellFromUserCell);
    }

    logJoin({
      roomId: this.roomId,
      roomCell: this.roomCell ?? "",
      joining: { userId: options.userId, sessionId: client.sessionId, roomCell },
      existingUsers,
      prisma,
    }).catch((err) => console.error("[CellRoom] logJoin error:", err.message));

    persistUser(options.userId, {
      lat: user.lat ?? 0,
      lng: user.lng ?? 0,
      h3UserCell: user.h3UserCell ?? "",
      h3RoomCell: roomCell,
      fuel: user.fuel ?? 100,
      xp: user.xp ?? 0,
      level: user.level ?? 1,
      coverage: user.coverage ?? 0,
    });
  }

  onLeave(client, consented) {
    const user = this.state.users.get(client.sessionId);
    if (user?.id) {
      this._saveRuntimeFuelState(user);
      const roomCell = user.h3UserCell ? cellToParent(user.h3UserCell, resRoomCell) : "";
      persistUser(user.id, {
        lat: user.lat,
        lng: user.lng,
        h3UserCell: user.h3UserCell ?? "",
        h3RoomCell: roomCell,
        fuel: user.fuel,
        xp: user.xp,
        level: user.level,
        coverage: user.coverage,
      });
    }
    this.state.users.delete(client.sessionId);
  }

  async onDispose() {
    if (this._cardRefillCooldownTimer) {
      clearTimeout(this._cardRefillCooldownTimer);
      this._cardRefillCooldownTimer = null;
    }
    try {
      await releaseRoomReservedInstances(String(this.roomId ?? ""));
    } catch (e) {
      console.error("[CellRoom] releaseRoomReservedInstances:", e?.message ?? e);
    }
    try {
      this._coinRuntime?.dispose?.();
    } catch {}
    this._coinRuntime = null;
    roomRegistry.remove(this.roomId);
    this.roomCell = null;
  }
}

module.exports = { CellRoom };