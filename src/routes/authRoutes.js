const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const jose = require("jose");
const { OAuth2Client } = require("google-auth-library");
const { prisma } = require("../db/prisma");
const { requireAdminToken, requireUserToken } = require("../middlewares/auth");
const { getNewUsername } = require("../utils/usernames");

function resolveSecret(envKey, fileEnvKey) {
  if (process.env[envKey]) return process.env[envKey].trim();
  const filePath = process.env[fileEnvKey];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch {
      // ignore
    }
  }
  return null;
}

const GOOGLE_IOS_CLIENT_ID = resolveSecret("GOOGLE_IOS_CLIENT_ID", "GOOGLE_IOS_CLIENT_ID_FILE");
const GOOGLE_ANDROID_CLIENT_ID = resolveSecret("GOOGLE_ANDROID_CLIENT_ID", "GOOGLE_ANDROID_CLIENT_ID_FILE");

const GOOGLE_CLIENT_IDS = {
  ios: GOOGLE_IOS_CLIENT_ID,
  android: GOOGLE_ANDROID_CLIENT_ID,
};

const APPLE_IOS_CLIENT_ID = resolveSecret("APPLE_IOS_CLIENT_ID", "APPLE_IOS_CLIENT_ID_FILE");
const APPLE_ANDROID_CLIENT_ID = resolveSecret("APPLE_ANDROID_CLIENT_ID", "APPLE_ANDROID_CLIENT_ID_FILE");

const APPLE_CLIENT_IDS = {
  ios: APPLE_IOS_CLIENT_ID,
  android: APPLE_ANDROID_CLIENT_ID,
};

const LOG_LOGIN_SOCIAL = path.join(__dirname, "../../logs/logLoginSocial.txt");

function logLoginSocial(endpoint, err) {
  try {
    fs.mkdirSync(path.dirname(LOG_LOGIN_SOCIAL), { recursive: true });
    const line = [
      new Date().toISOString(),
      `[${endpoint}]`,
      "message:",
      err?.message ?? String(err),
      err?.code ? `code: ${err.code}` : "",
      err?.cause ? `cause: ${err.cause?.message ?? err.cause}` : "",
      err?.stack ? `\n  stack: ${err.stack}` : "",
    ]
      .filter(Boolean)
      .join(" ") + "\n";
    fs.appendFileSync(LOG_LOGIN_SOCIAL, line);
  } catch (_) {
    // ignore
  }
}

/** JWKS da Apple — identity token (aud = Bundle ID / Service ID da plataforma). */
const APPLE_JWKS = jose.createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));

async function verifyAppleIdentityToken(idToken, audience) {
  const { payload } = await jose.jwtVerify(idToken, APPLE_JWKS, {
    issuer: "https://appleid.apple.com",
    audience,
  });
  return payload;
}

const ACCESS_EXPIRES_IN = "30m";
const REFRESH_EXPIRES_DAYS = 30;
const ACCESS_EXPIRES_SECONDS = 30 * 60; // 1800

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: { userId, tokenHash, expiresAt },
  });
  return token;
}

async function authRoutes(fastify) {
  // POST /auth/guest — cria usuário guest; devolve id, access_token, refresh_token
  fastify.post("/guest", { preHandler: requireAdminToken }, async (request, reply) => {
    const avatarId = Math.floor(Math.random() * 69) + 1;
    const maxTries = 10;
    let username;
    for (let tryCount = 0; tryCount < maxTries; tryCount++) {
      const candidate = getNewUsername();
      const existing = await prisma.user.findUnique({
        where: { username: candidate },
      });
      if (!existing) {
        username = candidate;
        break;
      }
    }
    if (!username) {
      return reply.code(500).send({ error: "Could not generate unique username" });
    }

    const user = await prisma.user.create({
      data: {
        is_guest: true,
        email: null,
        provider: null,
        providerId: null,
        username,
        avatarId,
        wallet: { create: {} },
      },
    });

    const access_token = fastify.jwt.sign(
      { sub: user.id, is_guest: true },
      { expiresIn: ACCESS_EXPIRES_IN }
    );
    const refresh_token = await createRefreshToken(user.id);

    return reply.code(201).send({
      id: user.id,
      access_token,
      refresh_token,
      username: user.username,
      avatarId: user.avatarId,
      expires_in: ACCESS_EXPIRES_SECONDS,
    });
  });

  // POST /auth/refresh — body: { refresh_token }; rotação: novo access + novo refresh
  fastify.post("/refresh", async (request, reply) => {
    const { refresh_token: raw } = request.body || {};
    if (!raw || typeof raw !== "string") {
      return reply.code(400).send({ error: "refresh_token required" });
    }

    const tokenHash = hashToken(raw);
    const token = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!token || token.expiresAt < new Date()) {
      return reply.code(401).send({ error: "invalid or expired refresh_token" });
    }

    const userId = token.userId;
    await prisma.refreshToken.delete({ where: { id: token.id } });

    const newRefreshToken = await createRefreshToken(userId);
    const access_token = fastify.jwt.sign(
      { sub: userId, is_guest: token.user.is_guest },
      { expiresIn: ACCESS_EXPIRES_IN }
    );

    return reply.send({
      access_token,
      refresh_token: newRefreshToken,
      expires_in: ACCESS_EXPIRES_SECONDS,
    });
  });

  /**
   * POST /auth/link-google
   * Vincula a conta Google ao usuário convidado autenticado (JWT).
   * Body: { token, platform } — ID token do Google; platform = "ios" | "android".
   * Extrai email e providerId (sub) do token e associa ao user atual.
   */
  fastify.post("/link-google", { preHandler: requireUserToken }, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { token: idToken, platform } = request.body || {};
    if (!idToken || typeof idToken !== "string") {
      return reply.code(400).send({ error: "token required" });
    }

    const normalizedPlatform = platform ? String(platform).toLowerCase() : "";
    if (!normalizedPlatform || (normalizedPlatform !== "ios" && normalizedPlatform !== "android")) {
      return reply.code(400).send({
        error: "platform required",
        message: "platform must be 'ios' or 'android'",
      });
    }
    const clientId = GOOGLE_CLIENT_IDS[normalizedPlatform];
    if (!clientId) {
      request.log?.error?.({ platform: normalizedPlatform }, "Google client ID not configured for platform");
      return reply.code(503).send({
        error: "Google login not configured",
        message: `GOOGLE_${normalizedPlatform.toUpperCase()}_CLIENT_ID (or _FILE) is not set`,
      });
    }

    let payload;
    try {
      const client = new OAuth2Client(clientId);
      const ticket = await client.verifyIdToken({
        idToken: idToken.trim(),
        audience: clientId,
      });
      payload = ticket.getPayload();
    } catch (err) {
      logLoginSocial("link-google", err);
      request.log?.warn?.(err, "Google ID token verification failed");
      return reply.code(400).send({
        error: "Invalid token",
        message: "Google ID token could not be verified",
      });
    }

    const email = payload.email || null;
    const providerId = payload.sub;
    if (!providerId) {
      return reply.code(400).send({ error: "Invalid token", message: "Missing sub claim" });
    }

    const provider = "google";

    // Conta Google já vinculada a outro usuário? Descarta o guest atual e devolve o user linkado + novos tokens.
    const existingByProvider = await prisma.user.findFirst({
      where: {
        provider,
        providerId,
        id: { not: userId },
      },
      select: {
        id: true,
        username: true,
        avatarId: true,
        email: true,
        provider: true,
        providerId: true,
        is_guest: true,
      },
    });
    if (existingByProvider) {
      const linkedUser = existingByProvider;
      const newRefreshToken = await createRefreshToken(linkedUser.id);
      const access_token = fastify.jwt.sign(
        { sub: linkedUser.id, is_guest: false },
        { expiresIn: ACCESS_EXPIRES_IN }
      );
      // Remove o guest para não deixar usuário órfão no banco
      await prisma.$transaction([
        prisma.instance.updateMany({ where: { ownerId: userId }, data: { ownerId: null } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);
      return reply.send({
        ok: true,
        message: "Account already linked; switched to existing user",
        user: { ...linkedUser, is_guest: false },
        access_token,
        refresh_token: newRefreshToken,
        expires_in: ACCESS_EXPIRES_SECONDS,
      });
    }

    // Email único: outro usuário já usa este email?
    if (email) {
      const existingByEmail = await prisma.user.findFirst({
        where: {
          email,
          id: { not: userId },
        },
      });
      if (existingByEmail) {
        return reply.code(409).send({
          error: "Email already in use",
          message: "This email is already associated with another user",
        });
      }
    }

    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: {
          email: email || undefined,
          provider,
          providerId,
          is_guest: false,
        },
        select: {
          id: true,
          email: true,
          provider: true,
          providerId: true,
          username: true,
          avatarId: true,
          is_guest: true,
        },
      });
      const newRefreshToken = await createRefreshToken(user.id);
      const access_token = fastify.jwt.sign(
        { sub: user.id, is_guest: false },
        { expiresIn: ACCESS_EXPIRES_IN }
      );
      return reply.send({
        ok: true,
        message: "Account linked successfully",
        user: { ...user, is_guest: false },
        access_token,
        refresh_token: newRefreshToken,
        expires_in: ACCESS_EXPIRES_SECONDS,
      });
    } catch (err) {
      if (err.code === "P2002") {
        return reply.code(409).send({
          error: "Conflict",
          message: "This account or email is already in use",
        });
      }
      request.log?.error?.(err);
      return reply.code(500).send({
        error: "Failed to link account",
        message: err.message,
      });
    }
  });

  /**
   * POST /auth/link-appleid
   * Igual ao link-google: vincula Sign in with Apple ao guest atual.
   * Body: { token, platform } — identity token (JWT) da Apple; platform = "ios" | "android".
   * O `sub` do token é estável e identifica o usuário Apple (email pode não vir no token após o 1º login).
   * Duplicata de conta: sempre por provider "apple" + providerId (sub), não só por email.
   */
  fastify.post("/link-appleid", { preHandler: requireUserToken }, async (request, reply) => {
    const userId = request.user?.sub;
    if (!userId) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const { token: identityToken, platform } = request.body || {};
    if (!identityToken || typeof identityToken !== "string") {
      return reply.code(400).send({ error: "token required" });
    }

    const normalizedPlatform = platform ? String(platform).toLowerCase() : "";
    if (!normalizedPlatform || (normalizedPlatform !== "ios" && normalizedPlatform !== "android")) {
      return reply.code(400).send({
        error: "platform required",
        message: "platform must be 'ios' or 'android'",
      });
    }
    const audience = APPLE_CLIENT_IDS[normalizedPlatform];
    if (!audience) {
      request.log?.error?.({ platform: normalizedPlatform }, "Apple client ID not configured for platform");
      return reply.code(503).send({
        error: "Apple Sign In not configured",
        message: `APPLE_${normalizedPlatform.toUpperCase()}_CLIENT_ID (or _FILE) is not set`,
      });
    }

    let payload;
    try {
      payload = await verifyAppleIdentityToken(identityToken.trim(), audience);
    } catch (err) {
      logLoginSocial("link-appleid", err);
      request.log?.warn?.(err, "Apple identity token verification failed");
      return reply.code(400).send({
        error: "Invalid token",
        message: "Apple identity token could not be verified",
      });
    }

    const providerId = payload.sub;
    if (!providerId) {
      return reply.code(400).send({ error: "Invalid token", message: "Missing sub claim" });
    }

    const email = typeof payload.email === "string" && payload.email ? payload.email.trim() : null;
    const provider = "apple";

    const existingByProvider = await prisma.user.findFirst({
      where: {
        provider,
        providerId,
        id: { not: userId },
      },
      select: {
        id: true,
        username: true,
        avatarId: true,
        email: true,
        provider: true,
        providerId: true,
        is_guest: true,
      },
    });
    if (existingByProvider) {
      const linkedUser = existingByProvider;
      const newRefreshToken = await createRefreshToken(linkedUser.id);
      const access_token = fastify.jwt.sign(
        { sub: linkedUser.id, is_guest: false },
        { expiresIn: ACCESS_EXPIRES_IN }
      );
      // Remove o guest para não deixar usuário órfão no banco
      await prisma.$transaction([
        prisma.instance.updateMany({ where: { ownerId: userId }, data: { ownerId: null } }),
        prisma.user.delete({ where: { id: userId } }),
      ]);
      return reply.send({
        ok: true,
        message: "Account already linked; switched to existing user",
        user: { ...linkedUser, is_guest: false },
        access_token,
        refresh_token: newRefreshToken,
        expires_in: ACCESS_EXPIRES_SECONDS,
      });
    }

    if (email) {
      const existingByEmail = await prisma.user.findFirst({
        where: {
          email,
          id: { not: userId },
        },
      });
      if (existingByEmail) {
        return reply.code(409).send({
          error: "Email already in use",
          message: "This email is already associated with another user",
        });
      }
    }

    const updateData = {
      provider,
      providerId,
      is_guest: false,
    };
    if (email) {
      updateData.email = email;
    }

    try {
      const user = await prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          provider: true,
          providerId: true,
          username: true,
          avatarId: true,
          is_guest: true,
        },
      });
      const newRefreshToken = await createRefreshToken(user.id);
      const access_token = fastify.jwt.sign(
        { sub: user.id, is_guest: false },
        { expiresIn: ACCESS_EXPIRES_IN }
      );
      return reply.send({
        ok: true,
        message: "Account linked successfully",
        user: { ...user, is_guest: false },
        access_token,
        refresh_token: newRefreshToken,
        expires_in: ACCESS_EXPIRES_SECONDS,
      });
    } catch (err) {
      if (err.code === "P2002") {
        return reply.code(409).send({
          error: "Conflict",
          message: "This Apple account is already in use",
        });
      }
      request.log?.error?.(err);
      return reply.code(500).send({
        error: "Failed to link account",
        message: err.message,
      });
    }
  });
}

module.exports = authRoutes;
