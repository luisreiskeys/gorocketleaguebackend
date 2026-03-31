const {
  importCsv,
  getAdminDatabaseVersion,
  upsertPlayers,
  generateDatabaseVersion,
  getProgressUpdates,
} = require("../controllers/adminPlayersController");
const { requireAdminToken } = require("../middlewares/auth");

async function adminPlayersRoutes(fastify) {
  // Criar/atualizar jogadores via JSON (upsert por ID)
  fastify.post("/", { preHandler: requireAdminToken }, upsertPlayers);

  // Ex: POST /admin/players/import-csv
  fastify.post("/import-csv", { preHandler: requireAdminToken }, importCsv);

  // Versão da base de jogadores (admin)
  fastify.get("/version", { preHandler: requireAdminToken }, getAdminDatabaseVersion);

  // Progresso incremental: cartas com progress_version > version do cliente (id, progress_version, max_supply, found_count)
  fastify.get("/progress", { preHandler: requireAdminToken }, getProgressUpdates);

  // Forçar geração de uma nova versão da base + arquivo players-<version>.json.gz
  fastify.post("/generate-version", { preHandler: requireAdminToken }, generateDatabaseVersion);
}

module.exports = adminPlayersRoutes;

