/** Config do Prisma CLI (db push, migrate). Em runtime o app usa adapter em src/db/prisma.js. */
module.exports = {
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "postgresql://user:password@localhost:5432/appdb",
  },
};
