/**
 * Log em arquivo para debug de joinOrCreate na CellRoom.
 * Registra: quem entrou, quem já estava na sala, e se no banco está em outra roomCell (h3_room_cell).
 *
 * Arquivo: backend/logs/colyseus-cell-join.log
 * grep "OUTRA_SALA" para achar usuários na sala errada.
 */
const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "colyseus-cell-join.log");

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
}

function line(parts) {
  return parts.join("\t") + "\n";
}

/**
 * Escreve linhas de log (timestamp + campos separados por tab).
 * Uma linha para o join; uma linha por usuário existente na sala.
 * Campos extras podem ser serializados no último campo (JSON).
 */
function write(data) {
  try {
    ensureDir(LOG_DIR);
    const ts = new Date().toISOString();
    const roomId = data.roomId ?? "";
    const roomCell = data.roomCell ?? "";
    const lines = [];

    const extraJson = data.extra ? JSON.stringify(data.extra) : "";

    if (data.joining) {
      lines.push(
        line([
          ts,
          data.event || "JOIN",
          roomId,
          roomCell,
          data.joining.userId ?? "",
          data.joining.sessionId ?? "",
          data.joining.roomCell ?? "",
          extraJson,
        ])
      );
    }

    if (data.existing && Array.isArray(data.existing)) {
      data.existing.forEach((u) => {
        const status = u.dbMatchesRoom === true ? "OK" : u.dbMatchesRoom === false ? "OUTRA_SALA" : "?";
        lines.push(
          line([
            ts,
            "EXISTING",
            roomId,
            roomCell,
            u.userId ?? "",
            u.sessionId ?? "",
            u.userCell ?? "",
            u.dbRoomCell ?? "",
            status,
            extraJson,
          ])
        );
      });
    }

    if (lines.length) fs.appendFileSync(LOG_FILE, lines.join(""));
  } catch (err) {
    console.error("[CellRoomJoinLogger]", err.message);
  }
}

/**
 * Loga um join: quem entrou, quem já estava, e se no DB está em outra roomCell.
 * @param {object} opts.joining - { userId, sessionId, roomCell }
 * @param {Array<{ userId, sessionId, userCell }>} opts.existingUsers
 */
async function logJoin({ roomId, roomCell, joining, existingUsers, prisma }) {
  const existing = [];

  for (const u of existingUsers || []) {
    let dbRoomCell = null;
    let dbMatchesRoom = null;
    if (u.userId && prisma) {
      try {
        const row = await prisma.user.findUnique({
          where: { id: u.userId },
          select: { h3RoomCell: true },
        });
        dbRoomCell = row?.h3RoomCell ?? null;
        dbMatchesRoom = roomCell != null && dbRoomCell !== null ? dbRoomCell === roomCell : null;
      } catch (_) {
        dbMatchesRoom = null;
      }
    }
    existing.push({
      userId: u.userId,
      sessionId: u.sessionId,
      userCell: u.userCell ?? u.h3Res9,
      dbRoomCell,
      dbMatchesRoom,
    });
  }

  write({
    event: "onJoin",
    roomId,
    roomCell,
    joining: joining
      ? {
          userId: joining.userId,
          sessionId: joining.sessionId,
          roomCell: joining.roomCell,
        }
      : undefined,
    existing: existing.length ? existing : undefined,
  });
}

module.exports = { logJoin, write };
