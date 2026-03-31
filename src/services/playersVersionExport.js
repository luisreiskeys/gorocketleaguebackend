const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { prisma } = require("../db/prisma");

const VERSIONS_DIR =
  process.env.PLAYERS_VERSIONS_DIR ||
  path.join(__dirname, "../../data/versions");

const BATCH_SIZE = 2000;

/**
 * Garante que o diretório de versões existe.
 */
function ensureVersionsDir() {
  if (!fs.existsSync(VERSIONS_DIR)) {
    fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  }
}

/**
 * Retorna o caminho do arquivo da versão (ex: data/versions/players-4.json.gz).
 */
function getVersionFilePath(version) {
  ensureVersionsDir();
  return path.join(VERSIONS_DIR, `players-${version}.json.gz`);
}

/** Mapeia row do raw query (snake_case) para o formato esperado (camelCase onde há @map) e serializa BigInt. */
function rawRowToJson(row) {
  const out = { ...row };
  // Defesa para variações de mapeamento do driver/client:
  // sempre expor `max_supply` no arquivo exportado.
  if (out.max_supply === undefined && out.maxSupply !== undefined) {
    out.max_supply = out.maxSupply;
    delete out.maxSupply;
  }
  if (out.card_updated_at !== undefined) {
    out.cardUpdatedAt = out.card_updated_at;
    delete out.card_updated_at;
  }
  if (out.created_at !== undefined) {
    out.createdAt = out.created_at;
    delete out.created_at;
  }
  if (out.updated_at !== undefined) {
    out.updatedAt = out.updated_at;
    delete out.updated_at;
  }
  if (typeof out.progress_version === "bigint") {
    out.progress_version = String(out.progress_version);
  }
  return out;
}

/**
 * Exporta todos os jogadores para um arquivo NDJSON gzipped.
 * Usa query raw para incluir todas as colunas da tabela (incl. max_supply, found_count, progress_version),
 * independente do Prisma Client gerado na imagem.
 * @param {number} version - Número da versão (usado no nome do arquivo)
 * @returns {Promise<string>} Caminho do arquivo gerado
 */
async function exportPlayersToVersionFile(version) {
  const filePath = getVersionFilePath(version);
  const gzip = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(filePath);

  return new Promise((resolve, reject) => {
    gzip.pipe(out);

    let lastId = 0;

    function writeBatch() {
      prisma
        .$queryRaw`SELECT * FROM players WHERE id > ${lastId} ORDER BY id LIMIT ${BATCH_SIZE}`
        .then((batch) => {
          if (batch.length === 0) {
            gzip.end();
            return;
          }
          for (const row of batch) {
            gzip.write(JSON.stringify(rawRowToJson(row)) + "\n");
          }
          lastId = batch[batch.length - 1].id;
          if (batch.length < BATCH_SIZE) {
            gzip.end();
          } else {
            setImmediate(writeBatch);
          }
        })
        .catch((err) => {
          gzip.destroy();
          out.destroy();
          reject(err);
        });
    }

    out.on("finish", () => resolve(filePath));
    gzip.on("error", reject);
    out.on("error", reject);

    writeBatch();
  });
}

/**
 * Verifica se o arquivo da versão existe.
 */
function versionFileExists(version) {
  const filePath = getVersionFilePath(version);
  return fs.existsSync(filePath);
}

module.exports = {
  getVersionFilePath,
  exportPlayersToVersionFile,
  versionFileExists,
  VERSIONS_DIR,
};
