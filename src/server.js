// src/server.js
const path = require("path");
const fs = require("fs");
const Fastify = require("fastify");
const multipart = require("@fastify/multipart");
const fastifyStatic = require("@fastify/static");
const jwt = require("@fastify/jwt");

const { createColyseusServer } = require("./colyseus");
const routes = require("./routes");
const { startCardWorldSpawnLoop, logCardPoolError } = require("./services/cardSpawnService");

process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err.message, err.stack);
});

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const filePath = process.env.JWT_SECRET_FILE;
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch (e) {
      console.error("[server] Falha ao ler JWT_SECRET_FILE:", e?.message || e);
    }
  }

  throw new Error("JWT_SECRET ou JWT_SECRET_FILE não configurado.");
}

async function start() {
  // 1) Fastify (não dá listen nele)
  const fastify = Fastify({ logger: true });

  fastify.register(jwt, { secret: resolveJwtSecret() });

  fastify.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  const playersPhotosDir =
    process.env.PLAYERS_PHOTOS_DIR ||
    path.join(__dirname, "..", "data", "players-photos");

  fastify.register(fastifyStatic, {
    root: playersPhotosDir,
    prefix: "/players/photos/",
  });

  const avatarsDir =
    process.env.AVATARS_DIR || path.join(__dirname, "..", "data", "avatars");

  fastify.register(fastifyStatic, {
    root: avatarsDir,
    prefix: "/public_assets/avatars/",
    decorateReply: false,
  });

  const teamShieldsDir =
    process.env.TEAM_SHIELDS_DIR || path.join(__dirname, "..", "data", "team_shields");
  fastify.register(fastifyStatic, {
    root: teamShieldsDir,
    prefix: "/public_assets/team_shields/",
    decorateReply: false,
  });

  fastify.register(routes);
  await fastify.ready();

  // 2) Colyseus (dono do HTTP em :3000) + /matchmake funcionando
  const colyseusServer = createColyseusServer({ fastify });

  // listen único na 3000
  colyseusServer.listen(PORT, HOST);
  const cardSpawnLoop = startCardWorldSpawnLoop();
  cardSpawnLoop.tick().catch((err) => logCardPoolError("refillWorldPool(initial)", err));

  console.log(`[server] Fastify + Colyseus em http://${HOST}:${PORT}`);
}

start().catch((err) => {
  console.error("[server] Erro ao subir:", err);
  process.exit(1);
});