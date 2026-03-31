const fs = require("fs");

function resolveSecretFromEnv(envKey, fileEnvKey) {
  if (process.env[envKey]) {
    return process.env[envKey];
  }

  const filePath = process.env[fileEnvKey];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch {
      // ignore read errors, will fall through and throw below
    }
  }

  return null;
}

const adminToken = resolveSecretFromEnv("ADMIN_API_TOKEN", "ADMIN_API_TOKEN_FILE");

if (!adminToken) {
  // Falhar no boot se o token admin não estiver configurado
  // para não expor rota sensível sem proteção.
  throw new Error("ADMIN_API_TOKEN (ou ADMIN_API_TOKEN_FILE) não configurado.");
}

async function requireAdminToken(request, reply) {
  const headerToken =
    request.headers["x-admin-token"] ||
    request.headers["x-admin-api-key"] ||
    request.headers["authorization"]?.replace("Bearer ", "");

  if (!headerToken || headerToken !== adminToken) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  return undefined;
}

/** Valida JWT de usuário (guest ou autenticado). Após o preHandler, request.user = { sub, is_guest, ... }. */
async function requireUserToken(request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    const isLinkGoogle = request.url?.includes("link-google");
    return reply.code(401).send({
      error: "Unauthorized",
      message: "Invalid or expired token",
      ...(isLinkGoogle && {
        hint: "Use the app access_token in Authorization header (Bearer) and Google id_token in body.token",
      }),
    });
  }
  return undefined;
}

module.exports = {
  requireAdminToken,
  requireUserToken,
};

