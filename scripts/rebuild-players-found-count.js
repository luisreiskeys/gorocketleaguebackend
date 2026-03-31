/* eslint-disable no-console */
const { prisma } = require("../src/db/prisma");

async function rebuildPlayersFoundCount() {
  const sql = `
    WITH counts AS (
      SELECT i.card_id::int AS card_id, COUNT(*)::int AS cnt
      FROM instances i
      WHERE i.found_when IS NOT NULL
      GROUP BY i.card_id
    ),
    updated_from_counts AS (
      UPDATE players p
      SET
        found_count = c.cnt,
        progress_version = p.progress_version + 1
      FROM counts c
      WHERE p.id = c.card_id
        AND p.found_count <> c.cnt
      RETURNING p.id
    ),
    updated_to_zero AS (
      UPDATE players p
      SET
        found_count = 0,
        progress_version = p.progress_version + 1
      WHERE p.found_count <> 0
        AND NOT EXISTS (
          SELECT 1 FROM counts c WHERE c.card_id = p.id
        )
      RETURNING p.id
    )
    SELECT
      (SELECT COUNT(*)::int FROM counts) AS cards_with_found_instances,
      (SELECT COUNT(*)::int FROM updated_from_counts) AS updated_from_counts,
      (SELECT COUNT(*)::int FROM updated_to_zero) AS updated_to_zero;
  `;

  const rows = await prisma.$queryRawUnsafe(sql);
  const stats = rows?.[0] || {};
  return {
    cardsWithFoundInstances: Number(stats.cards_with_found_instances || 0),
    updatedFromCounts: Number(stats.updated_from_counts || 0),
    updatedToZero: Number(stats.updated_to_zero || 0),
    totalPlayersUpdated:
      Number(stats.updated_from_counts || 0) + Number(stats.updated_to_zero || 0),
  };
}

async function main() {
  console.log("[rebuild-players-found-count] starting...");
  const result = await rebuildPlayersFoundCount();
  console.log("[rebuild-players-found-count] done:", result);
}

main()
  .catch((err) => {
    console.error("[rebuild-players-found-count] failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
