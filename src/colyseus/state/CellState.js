/**
 * Estado da sala (RES 8): mapa de usuários por sessionId.
 */
const schema = require("@colyseus/schema");
const Schema = schema.Schema;
const MapSchema = schema.MapSchema;
const { UserState } = require("./UserState");
const { CoinState } = require("./CoinState");
const { CardState } = require("./CardState");

class CellOwnerState extends Schema {
  constructor() {
    super();
    this.userId = "";
  }
}
schema.defineTypes(CellOwnerState, {
  userId: "string",
});

class CellFlagState extends Schema {
  constructor() {
    super();
    this.lat = 0;
    this.lng = 0;
    this.isCaptured = false;
  }
}
schema.defineTypes(CellFlagState, {
  lat: "number",
  lng: "number",
  isCaptured: "boolean",
});

/** Preços / parâmetros de economia visíveis ao cliente (futuro: por zona / h3RoomCell). */
class CellRoomEconomyState extends Schema {
  constructor() {
    super();
    /** Moedas por cada 1% do tanque a reabastecer (ver `fuelPurchaseService`). */
    this.fuelPurchaseCoinsPerPercent = 1;
    /** Capacidade máxima do tanque (igual `DEFAULT_MAX_FUEL` no backend). */
    this.maxFuel = 100;
  }
}
schema.defineTypes(CellRoomEconomyState, {
  fuelPurchaseCoinsPerPercent: "number",
  maxFuel: "number",
});

class CellState extends Schema {
  constructor() {
    super();
    this.users = new MapSchema();
    this.coins = new MapSchema();
    this.cards = new MapSchema();
    this.owner = new CellOwnerState();
    this.flag = new CellFlagState();
    this.economy = new CellRoomEconomyState();
  }
}

schema.defineTypes(CellState, {
  users: { map: UserState },
  coins: { map: CoinState },
  cards: { map: CardState },
  owner: CellOwnerState,
  flag: CellFlagState,
  economy: CellRoomEconomyState,
});

module.exports = { CellState };
