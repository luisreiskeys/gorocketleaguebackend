const { parse } = require("csv-parse/sync");
const { prisma } = require("../db/prisma");
const {
  exportPlayersToVersionFile,
  getVersionFilePath,
  versionFileExists,
} = require("../services/playersVersionExport");
const fs = require("fs");

function parseIntField(row, key) {
  const value = row[key];
  if (value === undefined || value === null || value === "") return null;
  const num = parseInt(String(value).trim(), 10);
  return Number.isNaN(num) ? null : num;
}

function parseArrayField(row, key) {
  const value = row[key];
  if (!value) return [];
  try {
    // CSV vem como "['RW', 'ST']" – convertemos para JSON válido
    const jsonLike = String(value).replace(/'/g, '"');
    const parsed = JSON.parse(jsonLike);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseDateField(row, key) {
  const value = row[key];
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = parseInt(String(value).trim(), 10);
  return Number.isNaN(num) ? null : num;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toStringArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [String(value)];
}

function mapCsvRowToPlayer(row) {
  return {
    rank: parseIntField(row, "Rank"),
    name: row["Name"],
    gender: row["GENDER"] || null,

    ovr: parseIntField(row, "OVR"),
    pac: parseIntField(row, "PAC"),
    sho: parseIntField(row, "SHO"),
    pas: parseIntField(row, "PAS"),
    dri: parseIntField(row, "DRI"),
    def: parseIntField(row, "DEF"),
    phy: parseIntField(row, "PHY"),

    acceleration: parseIntField(row, "Acceleration"),
    sprintSpeed: parseIntField(row, "Sprint Speed"),
    positioning: parseIntField(row, "Positioning"),
    finishing: parseIntField(row, "Finishing"),
    shotPower: parseIntField(row, "Shot Power"),
    longShots: parseIntField(row, "Long Shots"),
    volleys: parseIntField(row, "Volleys"),
    penalties: parseIntField(row, "Penalties"),
    vision: parseIntField(row, "Vision"),
    crossing: parseIntField(row, "Crossing"),
    freeKickAcc: parseIntField(row, "Free Kick Accuracy"),
    shortPassing: parseIntField(row, "Short Passing"),
    longPassing: parseIntField(row, "Long Passing"),
    curve: parseIntField(row, "Curve"),
    dribbling: parseIntField(row, "Dribbling"),
    agility: parseIntField(row, "Agility"),
    balance: parseIntField(row, "Balance"),
    reactions: parseIntField(row, "Reactions"),
    ballControl: parseIntField(row, "Ball Control"),
    composure: parseIntField(row, "Composure"),
    interceptions: parseIntField(row, "Interceptions"),
    headingAcc: parseIntField(row, "Heading Accuracy"),
    defAwareness: parseIntField(row, "Def Awareness"),
    standingTackle: parseIntField(row, "Standing Tackle"),
    slidingTackle: parseIntField(row, "Sliding Tackle"),
    jumping: parseIntField(row, "Jumping"),
    stamina: parseIntField(row, "Stamina"),
    strength: parseIntField(row, "Strength"),
    aggression: parseIntField(row, "Aggression"),

    position: row["Position"] || null,
    weakFoot: parseIntField(row, "Weak foot"),
    skillMoves: parseIntField(row, "Skill moves"),
    preferredFoot: row["Preferred foot"] || null,

    heightRaw: row["Height"] || null,
    weightRaw: row["Weight"] || null,

    alternativePositions: parseArrayField(row, "Alternative positions"),
    playStyle: parseArrayField(row, "play style"),

    age: parseIntField(row, "Age"),
    nation: row["Nation"] || null,
    league: row["League"] || null,
    team: row["Team"] || null,

    // url não vem do CSV: é preenchida pelo script de fotos (fetch-player-photos.js)

    gkDiving: parseIntField(row, "GK Diving"),
    gkHandling: parseIntField(row, "GK Handling"),
    gkKicking: parseIntField(row, "GK Kicking"),
    gkPositioning: parseIntField(row, "GK Positioning"),
    gkReflexes: parseIntField(row, "GK Reflexes"),

    cardUpdatedAt: parseDateField(row, "card updatedAt"),
  };
}

/**
 * Mapeia payload JSON (endpoint admin) para o formato da tabela Player.
 * Espera campos já com os mesmos nomes do modelo (rank, ovr, pac, ...).
 */
function mapJsonPayloadToPlayer(data) {
  return {
    rank: toInt(data.rank),
    name: data.name,
    gender: data.gender ?? null,

    ovr: toInt(data.ovr),
    pac: toInt(data.pac),
    sho: toInt(data.sho),
    pas: toInt(data.pas),
    dri: toInt(data.dri),
    def: toInt(data.def),
    phy: toInt(data.phy),

    acceleration: toInt(data.acceleration),
    sprintSpeed: toInt(data.sprintSpeed),
    positioning: toInt(data.positioning),
    finishing: toInt(data.finishing),
    shotPower: toInt(data.shotPower),
    longShots: toInt(data.longShots),
    volleys: toInt(data.volleys),
    penalties: toInt(data.penalties),
    vision: toInt(data.vision),
    crossing: toInt(data.crossing),
    freeKickAcc: toInt(data.freeKickAcc),
    shortPassing: toInt(data.shortPassing),
    longPassing: toInt(data.longPassing),
    curve: toInt(data.curve),
    dribbling: toInt(data.dribbling),
    agility: toInt(data.agility),
    balance: toInt(data.balance),
    reactions: toInt(data.reactions),
    ballControl: toInt(data.ballControl),
    composure: toInt(data.composure),
    interceptions: toInt(data.interceptions),
    headingAcc: toInt(data.headingAcc),
    defAwareness: toInt(data.defAwareness),
    standingTackle: toInt(data.standingTackle),
    slidingTackle: toInt(data.slidingTackle),
    jumping: toInt(data.jumping),
    stamina: toInt(data.stamina),
    strength: toInt(data.strength),
    aggression: toInt(data.aggression),

    position: data.position ?? null,
    weakFoot: toInt(data.weakFoot),
    skillMoves: toInt(data.skillMoves),
    preferredFoot: data.preferredFoot ?? null,

    heightRaw: data.heightRaw ?? null,
    weightRaw: data.weightRaw ?? null,

    alternativePositions: toStringArray(data.alternativePositions),
    playStyle: toStringArray(data.playStyle),

    age: toInt(data.age),
    nation: data.nation ?? null,
    league: data.league ?? null,
    team: data.team ?? null,

    // Para endpoints admin, permitimos setar url explicitamente (ou deixar null).
    url: data.url ?? null,

    gkDiving: toInt(data.gkDiving),
    gkHandling: toInt(data.gkHandling),
    gkKicking: toInt(data.gkKicking),
    gkPositioning: toInt(data.gkPositioning),
    gkReflexes: toInt(data.gkReflexes),

    cardUpdatedAt: toDate(data.cardUpdatedAt),
  };
}

function hasDifferences(existing, data) {
  return Object.keys(data).some((key) => {
    const before = existing[key];
    const after = data[key];
    if (Array.isArray(before) || Array.isArray(after)) {
      const a = Array.isArray(before) ? before : [];
      const b = Array.isArray(after) ? after : [];
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return true;
      }
      return false;
    }
    return (before ?? null) !== (after ?? null);
  });
}

/**
 * Processa o CSV: apenas upsert (insert ou update) por linha.
 * Nunca remove jogadores: se um jogador existe na base e não vem no CSV
 * (ex: aposentado), ele permanece – as cartas não deixam de existir.
 */
async function processImport(records) {
  let changedCount = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const row of records) {
    const id = parseIntField(row, "ID");
    if (!id) {
      // pula linhas sem ID
      // eslint-disable-next-line no-continue
      continue;
    }

    const data = mapCsvRowToPlayer(row);
    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.player.findUnique({ where: { id } });

    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.player.create({
        data: {
          id,
          ...data,
        },
      });
      changedCount += 1;
    } else if (hasDifferences(existing, data)) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.player.update({
        where: { id },
        data,
      });
      changedCount += 1;
    }
  }

  if (changedCount > 0) {
    await prisma.databasePlayersVersion.upsert({
      where: { id: 1 },
      update: {
        version: {
          increment: 1,
        },
      },
      create: {
        id: 1,
        version: 1,
      },
    });

    const row = await prisma.databasePlayersVersion.findUnique({
      where: { id: 1 },
    });
    if (row) {
      try {
        await exportPlayersToVersionFile(row.version);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[adminPlayersController] erro ao gerar arquivo da versão:", err);
      }
    }
  }

  return changedCount;
}

async function importCsv(request, reply) {
  const file = await request.file();

  if (!file) {
    return reply.code(400).send({ error: "Arquivo CSV não enviado" });
  }

  if (!file.filename.toLowerCase().endsWith(".csv")) {
    return reply.code(400).send({ error: "O arquivo deve ser um .csv" });
  }

  const buffer = await file.toBuffer();
  const content = buffer.toString("utf8");

  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
  });

  // Dispara o processamento em background para não segurar a request.
  setImmediate(() => {
    processImport(records).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[adminPlayersController] erro ao processar import CSV:", err);
    });
  });

  return reply.code(202).send({
    status: "accepted",
    totalRows: records.length,
    message: "Import de jogadores iniciado em background",
  });
}

async function readDatabaseVersion() {
  const row = await prisma.databasePlayersVersion.findUnique({
    where: { id: 1 },
  });

  if (!row) {
    return { version: 0, updatedAt: null };
  }

  return { version: row.version, updatedAt: row.updatedAt };
}

async function getAdminDatabaseVersion(request, reply) {
  const data = await readDatabaseVersion();
  return reply.send(data);
}

/**
 * Endpoint unificado: consulta versão e, se localVersion for menor que a do servidor,
 * inclui downloadUrl para o app baixar o arquivo pré-gerado (NDJSON gzip).
 * Query: localVersion (opcional) – versão que o app tem localmente (ex: SQLite).
 */
async function getPublicDatabaseVersion(request, reply) {
  const data = await readDatabaseVersion();
  const localVersion = request.query?.localVersion;

  if (localVersion !== undefined && localVersion !== null && localVersion !== "") {
    const local = parseInt(String(localVersion).trim(), 10);
    if (!Number.isNaN(local) && data.version > local && versionFileExists(data.version)) {
      data.downloadUrl = `/players/versions/${data.version}/download`;
    }
  }

  return reply.send(data);
}

/**
 * Serve o arquivo pré-gerado da versão (players-<version>.json.gz).
 * Retorna 404 se a versão for inválida ou o arquivo não existir.
 */
async function downloadVersionFile(request, reply) {
  const version = parseInt(request.params.version, 10);
  if (Number.isNaN(version) || version < 1) {
    return reply.code(400).send({ error: "Versão inválida" });
  }
  if (!versionFileExists(version)) {
    return reply.code(404).send({ error: "Arquivo desta versão não encontrado" });
  }
  const filePath = getVersionFilePath(version);
  const stream = fs.createReadStream(filePath);
  return reply
    .header("Content-Type", "application/gzip")
    .header("Content-Disposition", `attachment; filename="players-${version}.json.gz"`)
    .send(stream);
}

/**
 * Endpoint admin para inserir/atualizar jogadores via payload JSON.
 * Espera um array de objetos com os campos do modelo Player.
 * Faz upsert por `id` (se existir, atualiza; se não, cria).
 * Nunca remove jogadores que não estejam no payload.
 */
async function upsertPlayers(request, reply) {
  const payload = request.body;

  if (!Array.isArray(payload) || payload.length === 0) {
    return reply.code(400).send({ error: "Body deve ser um array de jogadores" });
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // eslint-disable-next-line no-restricted-syntax
  for (const item of payload) {
    if (!item || typeof item !== "object") {
      // eslint-disable-next-line no-continue
      continue;
    }

    const id = item.id != null ? Number(item.id) : NaN;
    if (Number.isNaN(id)) {
      // eslint-disable-next-line no-console
      console.warn("[upsertPlayers] item sem id válido, pulando:", item);
      // eslint-disable-next-line no-continue
      continue;
    }

    const data = mapJsonPayloadToPlayer(item);

    // eslint-disable-next-line no-await-in-loop
    const existing = await prisma.player.findUnique({ where: { id } });

    if (!existing) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.player.create({
        data: {
          id,
          ...data,
        },
      });
      created += 1;
    } else if (hasDifferences(existing, data)) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.player.update({
        where: { id },
        data,
      });
      updated += 1;
    } else {
      skipped += 1;
    }
  }

  return reply.send({
    status: "ok",
    created,
    updated,
    skipped,
    total: payload.length,
  });
}

/**
 * Endpoint admin para forçar geração de uma nova versão da base de jogadores.
 * Incrementa `database_players_version.version`, gera um novo arquivo
 * players-<version>.json.gz a partir do estado atual da tabela `players` e
 * devolve a versão gerada.
 *
 * Body opcional: { "note": string }
 */
async function generateDatabaseVersion(request, reply) {
  const note = request.body?.note ?? null;

  const current = await prisma.databasePlayersVersion.findUnique({
    where: { id: 1 },
  });
  const nextVersion = (current?.version ?? 0) + 1;

  try {
    await exportPlayersToVersionFile(nextVersion);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[adminPlayersController] erro ao gerar arquivo da nova versão:", err);
    return reply
      .code(500)
      .send({ error: "Falha ao gerar arquivo da nova versão", details: `${err}` });
  }

  let row;
  if (!current) {
    row = await prisma.databasePlayersVersion.create({
      data: {
        id: 1,
        version: nextVersion,
        note,
      },
    });
  } else {
    row = await prisma.databasePlayersVersion.update({
      where: { id: 1 },
      data: {
        version: nextVersion,
        ...(note ? { note } : {}),
      },
    });
  }

  return reply.send({
    status: "ok",
    version: row.version,
    updatedAt: row.updatedAt,
  });
}

/** GET /admin/players/progress?version=N - cartas com progress_version > N (id, progress_version, max_supply, found_count) */
async function getProgressUpdates(request, reply) {
  if (reply.sent) return;

  const raw = request.query.version;
  const userVersion = raw === undefined || raw === "" ? 0n : BigInt(parseInt(String(raw), 10) || 0);

  const rows = await prisma.player.findMany({
    where: { progress_version: { gt: userVersion } },
    select: { id: true, progress_version: true, max_supply: true, found_count: true },
    orderBy: { id: "asc" },
  });

  const body = rows.map((r) => ({
    id: r.id,
    progress_version: String(r.progress_version),
    max_supply: r.max_supply,
    found_count: r.found_count,
  }));
  return reply.send(body);
}

module.exports = {
  importCsv,
  getAdminDatabaseVersion,
  getPublicDatabaseVersion,
  downloadVersionFile,
  upsertPlayers,
  generateDatabaseVersion,
  getProgressUpdates,
};

