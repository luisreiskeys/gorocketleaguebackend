/**
 * Script: baixa fotos diretamente da URL da EA (ratings-images-prod),
 * usando o padrão:
 *
 *   https://ratings-images-prod.pulse.ea.com/FC26/components/players/p{id}.webp
 *
 * onde {id} é o ID do jogador na nossa tabela (já compatível com o ID da EA).
 *
 * Processa apenas jogadores onde url está vazia (null ou '').
 * Ordena por rank (melhores primeiro).
 *
 * Uso: docker exec -it grl_backend node scripts/fetch-player-photos.js
 * Opcional:
 *   DELAY_MS=2000   (delay entre jogadores; default 0)
 *   MAX_PLAYERS=5000 (limitar número de jogadores processados por rodada)
 */

const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db/prisma");

const PHOTOS_DIR =
  process.env.PLAYERS_PHOTOS_DIR ||
  path.join(__dirname, "../data/players-photos");

const DELAY_MS = parseInt(process.env.DELAY_MS || "0", 10);
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || "0", 10);

// Base da URL da EA. Pode ser sobrescrito via EA_IMAGE_BASE se necessário.
const EA_IMAGE_BASE =
  process.env.EA_IMAGE_BASE ||
  "https://ratings-images-prod.pulse.ea.com/FC26/components/players";

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
 * Constrói a URL da imagem da EA para um determinado ID.
 */
function buildEaImageUrl(playerId) {
  return `${EA_IMAGE_BASE}/p${playerId}.webp`;
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
  let ext = "jpg";
  if (contentType.includes("webp")) ext = "webp";
  else if (contentType.includes("png")) ext = "png";
  const filename = `${playerId}.${ext}`;
  const filePath = path.join(PHOTOS_DIR, filename);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 500) return null;
  fs.writeFileSync(filePath, buffer);
  return ext;
}

async function main() {
  ensurePhotosDir();

  const players = await prisma.player.findMany({
    where: {
      OR: [{ url: null }, { url: "" }],
    },
    select: { id: true, name: true, nation: true, team: true, rank: true },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
    take: MAX_PLAYERS && Number.isFinite(MAX_PLAYERS) && MAX_PLAYERS > 0
      ? MAX_PLAYERS
      : undefined,
  });

  console.log(
    `[fetch-player-photos] Processando ${players.length} jogadores com url vazia (ordenado por rank)`
  );

  let ok = 0;
  let fail = 0;

  for (const player of players) {
    const imageUrl = buildEaImageUrl(player.id);
    try {
      const ext = await downloadAndSave(imageUrl, player.id);
      if (!ext) {
        fail += 1;
        console.log(
          `[skip] ${player.id} ${player.name} – falha ao baixar (${imageUrl})`
        );
        if (DELAY_MS > 0) await sleep(DELAY_MS);
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
      fail += 1;
      console.error(
        `[erro] ${player.id} ${player.name} (${imageUrl}):`,
        err && err.message ? err.message : err
      );
    }
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  console.log(`[fetch-player-photos] fim: ${ok} ok, ${fail} falha/skip`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
