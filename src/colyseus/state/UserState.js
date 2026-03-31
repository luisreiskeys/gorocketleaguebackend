/**
 * Estado sincronizado de um usuário na sala (espelho dos dados de renderização).
 */
const schema = require("@colyseus/schema");
const Schema = schema.Schema;

class UserState extends Schema {}

schema.defineTypes(UserState, {
  id: "string",
  username: "string",
  avatarId: "string",

  level: "number",
  xp: "number",
  fuel: "number",
  coverage: "number",
  maxFuel: "number",
  refillInterval: "number",
  lastRefillAt: "number",
  lastFuelUpdateAt: "number",
  refillActive: "boolean",
  refillGranted: "number",

  // Estatísticas de território (derivadas de cell_ownership).
  flagsOwned: "number",
  ownedAreaKm2: "number",

  lat: "number",
  lng: "number",

  /** Índice H3 da célula do usuário (resolução = H3_RES_USER_CELL no backend). */
  h3UserCell: "string",
  deltaKm: "number",
});

module.exports = { UserState };
