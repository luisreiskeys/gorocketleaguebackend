const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const { Pool } = require("pg");

function buildDatabaseUrl() {
  const host = process.env.POSTGRES_HOST || "postgres";
  const port = process.env.POSTGRES_PORT || "5432";
  const dbName = process.env.POSTGRES_DB || "appdb";

  let user = process.env.POSTGRES_USER;
  let password = process.env.POSTGRES_PASSWORD;

  if (!user && process.env.POSTGRES_USER_FILE) {
    user = fs.readFileSync(process.env.POSTGRES_USER_FILE, "utf8").trim();
  }

  if (!password && process.env.POSTGRES_PASSWORD_FILE) {
    password = fs.readFileSync(process.env.POSTGRES_PASSWORD_FILE, "utf8").trim();
  }

  if (!user || !password) {
    throw new Error("Database credentials not found (user/password).");
  }

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(
    password
  )}@${host}:${port}/${dbName}`;
}

// Usa Driver Adapter do Postgres para Prisma 7 (engine type "client").
// A Pool do `pg` é configurada com a URL construída a partir dos secrets.
const pool = new Pool({
  connectionString: buildDatabaseUrl(),
});

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
});

module.exports = {
  prisma,
};

