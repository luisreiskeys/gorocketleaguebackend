const publicRoutes = require("./publicRoutes");
const adminPlayersRoutes = require("./adminPlayersRoutes");
const authRoutes = require("./authRoutes");
const userRoutes = require("./userRoutes");
const teamRoutes = require("./teamRoutes");
const walletRoutes = require("./walletRoutes");
const tradeRoutes = require("./tradeRoutes");
const battleRoutes = require("./battleRoutes");
const salasColyseusRoutes = require("./salasColyseusRoutes");

async function routes(fastify) {
  // Rotas públicas / healthcheck
  await fastify.register(publicRoutes);

  // Autenticação (guest, login futuro)
  await fastify.register(authRoutes, { prefix: "/auth" });

  // Usuário: listar avatars, atualizar perfil
  await fastify.register(userRoutes);
  await fastify.register(teamRoutes);

  // Carteira de coins (saldo + histórico)
  await fastify.register(walletRoutes);

  // Trocas de instâncias entre usuários
  await fastify.register(tradeRoutes);
  await fastify.register(battleRoutes);

  // Rotas administrativas relacionadas a players
  await fastify.register(adminPlayersRoutes, { prefix: "/admin/players" });

  // Página em tempo real: salas Colyseus e usuários (ip:3000/salasColyseus)
  await fastify.register(salasColyseusRoutes);
}

module.exports = routes;

