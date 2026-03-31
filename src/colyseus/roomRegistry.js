/**
 * Registro in-memory das salas CellRoom ativas (para listagem em /salasColyseus).
 * CellRoom chama add() em onCreate e remove() em onDispose.
 */
const rooms = new Map();

function add(room) {
  if (room && room.roomId) rooms.set(room.roomId, room);
}

function remove(roomId) {
  if (roomId) rooms.delete(roomId);
}

function getSnapshot() {
  const list = [];
  rooms.forEach((room) => {
    const users = [];
    let cellState = null;
    try {
      if (room.state) {
        if (room.state.users) {
          room.state.users.forEach((u, sessionId) => {
            users.push({
              sessionId,
              userId: u.id ?? "",
              username: u.username ?? "",
              avatarId: u.avatarId ?? "",
              h3UserCell: u.h3UserCell ?? "",
              fuel: u.fuel ?? 0,
              coverage: u.coverage ?? 0,
              lat: u.lat,
              lng: u.lng,
            });
          });
        }

        const owner = room.state.owner || {};
        const flag = room.state.flag || {};
        let coinCount = 0;
        try {
          if (room.state.coins && typeof room.state.coins.forEach === "function") {
            room.state.coins.forEach(() => {
              coinCount += 1;
            });
          }
        } catch {
          coinCount = -1;
        }
        cellState = {
          ownerUserId: owner.userId ?? "",
          flagLat: typeof flag.lat === "number" ? flag.lat : null,
          flagLng: typeof flag.lng === "number" ? flag.lng : null,
          isCaptured: !!flag.isCaptured,
          coinCount,
        };
      }
    } catch (e) {
      users.push({ error: String(e.message) });
    }
    list.push({
      roomId: room.roomId,
      roomCell: room.roomCell ?? "",
      userCount: users.length,
      users,
      cellState,
    });
  });
  return list;
}

module.exports = { add, remove, getSnapshot };
