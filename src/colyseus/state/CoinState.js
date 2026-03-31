/**
 * Um coin pickup na sala (sincronizado com clientes via @colyseus/schema).
 */
const schema = require("@colyseus/schema");
const Schema = schema.Schema;

class CoinState extends Schema {
  constructor() {
    super();
    this.id = "";
    this.lat = 0;
    this.lng = 0;
    this.value = 1;
    /** Resolução H3 usada para spawn (debug / validação client-side opcional). */
    this.h3SpawnCell = "";
    /** Índice H3 em H3_RES_COLLIDE (igual à flag) — coleta automática em updatePosition. */
    this.h3CollideCell = "";
    this.spawnedAt = 0;
  }
}

schema.defineTypes(CoinState, {
  id: "string",
  lat: "number",
  lng: "number",
  value: "number",
  h3SpawnCell: "string",
  h3CollideCell: "string",
  spawnedAt: "number",
});

module.exports = { CoinState };
