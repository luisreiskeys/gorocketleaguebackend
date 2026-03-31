/**
 * Script: preenche fotos dos jogadores usando a API Serper (Google Images).
 *
 * Regras:
 * - Só processa jogadores com `url` vazia (null ou '').
 * - Ordena por `rank` (melhores primeiro).
 * - Limite máximo de chamadas configurável (default 2500) para respeitar a cota.
 * - Query: `${name} ${team} headshot` (se não houver team, usa só `${name} headshot`).
 * - Usa `imageUrl` do primeiro item de `images` cuja `domain` NÃO seja `ea.com`
 *   (pula imagens de cartas da EA).
 *
 * Uso (dentro do container backend):
 *   docker exec -it grl_backend node scripts/fetch-player-photos-serper.js
 *
 * Opcional:
 *   SERPER_MAX_CALLS=1000  (limitar chamadas abaixo de 2500)
 *   DELAY_MS=100           (delay entre chamadas, default 0)
 */

const fs = require("fs");
const path = require("path");
const { prisma } = require("../src/db/prisma");

const PHOTOS_DIR =
  process.env.PLAYERS_PHOTOS_DIR ||
  path.join(__dirname, "../data/players-photos");

// Chave fornecida pelo usuário (pode ser sobrescrita por SERPER_API_KEY se quiser).
const SERPER_API_KEY =
  process.env.SERPER_API_KEY ||
  "aee9e35e2e4763ab9d8d7546fcab8d3ce9883391";

const SERPER_URL = "https://google.serper.dev/images";
const MAX_CALLS = parseInt(process.env.SERPER_MAX_CALLS || "2500", 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || "0", 10);
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
 * Faz a busca na Serper e retorna a melhor imageUrl válida (não EA).
 */
async function searchSerperImageUrl(name, team) {
  const query =
    team && String(team).trim()
      ? `${name} ${String(team).trim()} headshot`
      : `${name} headshot`;

  const res = await fetch(SERPER_URL, {
    method: "POST",
    headers: {
      "X-API-KEY": SERPER_API_KEY,
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({ q: query }),
  });

  if (!res.ok) {
    const text = await res.text();
    // eslint-disable-next-line no-console
    console.error(
      `[serper] erro HTTP ${res.status} para "${query}": ${text.slice(0, 200)}`
    );
    return null;
  }

  const data = await res.json();
  const images = data.images || [];
  if (!images.length) return null;

  // Escolhe a primeira imagem cujo domínio NÃO seja EA (www.ea.com, ratings-images-prod.pulse.ea.com etc.)
  for (const img of images) {
    const url = img.imageUrl || "";
    const domain = (img.domain || "").toLowerCase();
    if (!url) continue;
    if (domain.includes("ea.com")) continue; // pula cartas EA
    return url;
  }

  return null;
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
  ensurePhotosDir();

  const players = await prisma.player.findMany({
    where: {
      OR: [{ url: null }, { url: "" }],
    },
    select: { id: true, name: true, nation: true, team: true, rank: true },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
    take: MAX_CALLS,
  });

  // eslint-disable-next-line no-console
  console.log(
    `[fetch-player-photos-serper] Processando até ${players.length} jogadores (limite ${MAX_CALLS}), url vazia, ordenado por rank`
  );

  let ok = 0;
  let skipNoImage = 0;
  let skipDownload = 0;

  for (const player of players) {
    try {
      const imageUrl = await searchSerperImageUrl(player.name, player.team);
      if (!imageUrl) {
        skipNoImage += 1;
        if (ok + skipNoImage + skipDownload <= 50) {
          // eslint-disable-next-line no-console
          console.log(
            `[skip] ${player.id} ${player.name} – nenhuma imagem válida encontrada`
          );
        }
        if (DELAY_MS > 0) await sleep(DELAY_MS);
        continue;
      }

      const ext = await downloadAndSave(imageUrl, player.id);
      if (!ext) {
        skipDownload += 1;
        // eslint-disable-next-line no-console
        console.log(
          `[skip] ${player.id} ${player.name} – falha ao baixar imagem`
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
      // eslint-disable-next-line no-console
      console.log(`[ok] ${player.id} ${player.name} -> ${urlPath}`);
    } catch (err) {
      skipDownload += 1;
      // eslint-disable-next-line no-console
      console.error(
        `[erro] ${player.id} ${player.name}:`,
        err && err.message ? err.message : err
      );
    }

    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[fetch-player-photos-serper] fim: ${ok} ok, ${skipNoImage} sem imagem, ${skipDownload} falha download`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });

