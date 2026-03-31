/**
 * Atualiza progresso de descoberta por carta (players.found_count/progress_version).
 */

/**
 * Incrementa found_count de uma carta e avança progress_version.
 * Deve ser chamado na mesma transação que marca a instancia como encontrada.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {number|string} cardId
 * @param {number} by
 */
async function incrementPlayerFoundProgress(tx, cardId, by = 1) {
  const delta = Math.max(0, Number(by) || 0);
  if (delta <= 0) return;
  await tx.player.update({
    where: { id: Number(cardId) },
    data: {
      found_count: { increment: delta },
      progress_version: { increment: BigInt(1) },
    },
  });
}

module.exports = {
  incrementPlayerFoundProgress,
};
