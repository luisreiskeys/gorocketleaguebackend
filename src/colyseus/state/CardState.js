/**
 * Uma carta no mapa da sala (projeção de Instance sem owner).
 */
const schema = require("@colyseus/schema");
const Schema = schema.Schema;

class CardState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.cardId = 0;
    this.name = "";
    this.ovr = 0;
    this.url = "";
    this.serialNumber = 0;
    this.serialMax = 0;
    this.serialClass = "";
    this.lat = 0;
    this.lng = 0;
    this.h3RoomCell = "";
    this.spawnSource = "";
    this.h3CollideCell = "";
    this.spawnedAt = 0;
  }
}

schema.defineTypes(CardState, {
  id: "string",
  cardId: "number",
  name: "string",
  ovr: "number",
  url: "string",
  serialNumber: "number",
  serialMax: "number",
  serialClass: "string",
  lat: "number",
  lng: "number",
  h3RoomCell: "string",
  spawnSource: "string",
  /** Mesma resolucao que a flag / coins (H3_RES_COLLIDE) — coleta automatica em updatePosition. */
  h3CollideCell: "string",
  spawnedAt: "number",
});

module.exports = { CardState };
