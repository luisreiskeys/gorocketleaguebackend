// colyseus.js
const { defineServer, defineRoom } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");

const { CellRoom } = require("./rooms/CellRoom");

/**
 * Cria o server Colyseus v0.17 (inclui /matchmake)
 * e permite plugar rotas externas via callback express(app).
 */
function createColyseusServer({ fastify }) {
  const server = defineServer({
    rooms: {
      // Matchmaking por h3RoomCell (resolução configurável: env H3_RES_ROOM_CELL).
      cell: defineRoom(CellRoom).filterBy(["h3RoomCell"]),
    },

    // WebSocket transport (ws)
    transport: new WebSocketTransport(),

    // "Express bridge": tudo que NÃO for /matchmake cai no Fastify
    express: (app) => {
      app.use((req, res, next) => {
        // Deixa o Colyseus responder o matchmaker:
        if (req.url && req.url.startsWith("/matchmake")) return next();

        // O resto vai para o Fastify:
        fastify.server.emit("request", req, res);
      });
    },
  });

  return server;
}

module.exports = { createColyseusServer };