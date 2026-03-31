const {
  getPublicDatabaseVersion,
  downloadVersionFile,
} = require("../controllers/adminPlayersController");
const { requireAdminToken } = require("../middlewares/auth");

async function publicRoutes(fastify) {
  fastify.get("/", async () => {
    return {
      status: "ok",
      message: "Hello World GoRocketLeague 🚀",
    };
  });

  // Endpoint unificado: versão + downloadUrl (protegido com admin token)
  // GET /players/version?localVersion=3 → { version, updatedAt, downloadUrl? }
  fastify.get("/players/version", { preHandler: requireAdminToken }, getPublicDatabaseVersion);

  // Download do arquivo pré-gerado da versão (protegido com admin token)
  fastify.get("/players/versions/:version/download", { preHandler: requireAdminToken }, downloadVersionFile);
}

module.exports = publicRoutes;
