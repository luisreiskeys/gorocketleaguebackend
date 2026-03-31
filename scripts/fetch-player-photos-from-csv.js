/**
 * Script: preenche fotos dos jogadores usando o CSV player_profiles.csv.
 *
 * - Match por nome (normalizado: "Silvio Adzic (1)" -> "Silvio Adzic").
 * - Ignora linhas do CSV onde current_club_name = "Retired".
 * - Usa Citizenship do CSV; desempate por nation (nosso player.nation deve estar
 *   na lista de cidadanias do CSV). Se houver mais de um resultado, ignora (não atualiza).
 * - Baixa player_image_url, salva em data/players-photos/{id}.ext e atualiza players.url.
 *
 * Processa apenas jogadores da nossa base com url vazia. Ordena por rank.
 *
 * Uso:
 *   docker exec -it grl_backend node scripts/fetch-player-photos-from-csv.js
 *   # ou com path do CSV (dentro do container):
 *   docker exec -it -e PLAYER_PROFILES_CSV=/app/player_profiles.csv grl_backend node scripts/fetch-player-photos-from-csv.js
 *
 * Montar o CSV no container: -v /caminho/player_profiles.csv:/app/player_profiles.csv
 * Opcional: DELAY_MS=200 (delay entre downloads)
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { prisma } = require("../src/db/prisma");

const PHOTOS_DIR =
  process.env.PLAYERS_PHOTOS_DIR ||
  path.join(__dirname, "../data/players-photos");

const CSV_PATH =
  process.env.PLAYER_PROFILES_CSV ||
  path.join(__dirname, "../../player_profiles.csv");

const DELAY_MS = parseInt(process.env.DELAY_MS || "200", 10);
const UA = "GoRocketLeague/1.0 (https://github.com/gorocketleague)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensurePhotosDir() {
  if (!fs.existsSync(PHOTOS_DIR)) {
    fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  }
}

/**
 * Normaliza nome do CSV: "Silvio Adzic (1)" -> "Silvio Adzic".
 */
function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

/**
 * Parse citizenship: "France  Nigeria" -> ["France", "Nigeria"].
 */
function parseCitizenship(citizenship) {
  if (!citizenship || typeof citizenship !== "string") return [];
  return citizenship
    .split(/\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Carrega o CSV e monta índice: nome normalizado -> [{ nations, url }, ...].
 * Exclui current_club_name === "Retired".
 */
function buildLookup(csvPath) {
  const content = fs.readFileSync(csvPath, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const byName = new Map();

  for (const row of rows) {
    const club = (row.current_club_name || "").trim();
    if (club.toLowerCase() === "retired") continue;

    const url = (row.player_image_url || "").trim();
    if (
      !url ||
      url ===
        "https://img.a.transfermarkt.technology/portrait/header/default.jpg"
    ) {
      // ignora imagens padrão/placeholder
      continue;
    }

    const name = normalizeName(row.player_name || "");
    if (!name) continue;

    const nations = parseCitizenship(row.citizenship || "");

    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({ nations, url, rawName: row.player_name });
  }

  return byName;
}

/**
 * Encontra um único match no índice por nome e nation (nosso player).
 * Retorna { url }, { duplicate: true } se 2+ matches, ou null se 0 matches.
 */
function findOneMatch(lookup, playerName, playerNation) {
  const key = normalizeName(playerName).toLowerCase();
  if (!key) return null;
  const candidates = lookup.get(key);
  if (!candidates || candidates.length === 0) return null;

  const nationNorm = (playerNation || "").trim();
  const filtered = candidates.filter((c) =>
    c.nations.some((n) => n.trim().toLowerCase() === nationNorm.toLowerCase())
  );

  if (filtered.length === 0) return null;
  if (filtered.length > 1) return { duplicate: true };
  return { url: filtered[0].url };
}

/**
 * Baixa a imagem e salva em PHOTOS_DIR/{id}.{ext}. Retorna a extensão ou null.
 */
async function downloadAndSave(imageUrl, playerId) {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": UA },
    redirect: "follow",
  });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "";
  const ext = contentType.includes("png") ? "png" : "jpg";
  const filename = `${playerId}.${ext}`;
  const filePath = path.join(PHOTOS_DIR, filename);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 500) return null;
  fs.writeFileSync(filePath, buffer);
  return ext;
}

async function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(
      `[fetch-player-photos-from-csv] CSV não encontrado: ${CSV_PATH}`
    );
    console.error(
      "Defina PLAYER_PROFILES_CSV ou coloque player_profiles.csv na raiz do projeto."
    );
    process.exit(1);
  }

  ensurePhotosDir();
  console.log(`[fetch-player-photos-from-csv] Carregando ${CSV_PATH}...`);
  const lookup = buildLookup(CSV_PATH);
  const totalKeys = lookup.size;
  let totalEntries = 0;
  lookup.forEach((arr) => (totalEntries += arr.length));
  console.log(
    `[fetch-player-photos-from-csv] Índice: ${totalKeys} nomes, ${totalEntries} linhas (sem Retired)`
  );

  const players = await prisma.player.findMany({
    where: {
      OR: [{ url: null }, { url: "" }],
    },
    select: { id: true, name: true, nation: true, team: true, rank: true },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
  });

  console.log(
    `[fetch-player-photos-from-csv] ${players.length} jogadores com url vazia (ordenado por rank)`
  );

  let ok = 0;
  let skipNoMatch = 0;
  let skipDuplicate = 0;
  let skipDownload = 0;

  for (const player of players) {
    try {
      const match = findOneMatch(lookup, player.name, player.nation);
      if (!match) {
        skipNoMatch += 1;
        if (ok + skipNoMatch + skipDuplicate + skipDownload <= 50) {
          console.log(`[skip] ${player.id} ${player.name} – sem match`);
        }
        await sleep(DELAY_MS);
        continue;
      }
      if (match.duplicate) {
        skipDuplicate += 1;
        if (skipDuplicate <= 20) {
          console.log(`[skip] ${player.id} ${player.name} – match duplicado (nome+nation)`);
        }
        await sleep(DELAY_MS);
        continue;
      }

      const ext = await downloadAndSave(match.url, player.id);
      if (!ext) {
        skipDownload += 1;
        console.log(`[skip] ${player.id} ${player.name} – falha ao baixar`);
        await sleep(DELAY_MS);
        continue;
      }

      const urlPath = `/players/photos/${player.id}.${ext}`;
      await prisma.player.update({
        where: { id: player.id },
        data: { url: urlPath },
      });
      ok += 1;
      console.log(`[ok] ${player.id} ${player.name} -> ${urlPath}`);
    } catch (err) {
      skipDownload += 1;
      console.error(`[erro] ${player.id} ${player.name}:`, err.message);
    }
    await sleep(DELAY_MS);
  }

  console.log(
    `[fetch-player-photos-from-csv] fim: ${ok} ok, ${skipNoMatch} sem match, ${skipDuplicate} duplicado, ${skipDownload} falha download`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
