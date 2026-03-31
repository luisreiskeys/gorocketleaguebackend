/**
 * Resolução H3 configurável por variáveis de ambiente (sem recompilar).
 * - resUserCell: resolução da célula do usuário (ex.: 9)
 * - resRoomCell: resolução da célula da sala (ex.: 8) — parent da user cell
 *
 * - resCollide: resolução usada para colisão com a flag (ex.: 12)
 *
 * Env: H3_RES_USER_CELL, H3_RES_ROOM_CELL, H3_RES_COLLIDE (inteiros)
 */
function parseRes(envKey, defaultValue) {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 && n <= 15 ? n : defaultValue;
}

const resUserCell = parseRes("H3_RES_USER_CELL", 9);
const resRoomCell = parseRes("H3_RES_ROOM_CELL", 8);
const resCollide = parseRes("H3_RES_COLLIDE", 12);

module.exports = {
  resUserCell,
  resRoomCell,
  resCollide,
};
