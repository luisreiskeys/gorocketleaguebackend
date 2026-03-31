const path = require("path");
const fs = require("fs");

const TEAM_SHIELDS_DIR =
  process.env.TEAM_SHIELDS_DIR || path.join(__dirname, "..", "..", "data", "team_shields");

const IMAGE_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".gif"];

/**
 * Quantidade de arquivos de imagem em `data/team_shields` (convenção: 1.webp, 2.webp, …).
 */
function countTeamShields() {
  try {
    if (!fs.existsSync(TEAM_SHIELDS_DIR)) return 0;
    const files = fs.readdirSync(TEAM_SHIELDS_DIR);
    return files.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return IMAGE_EXTENSIONS.includes(ext);
    }).length;
  } catch {
    return 0;
  }
}

/**
 * Escolhe um id aleatório entre 1 e `countTeamShields()`. Se não houver arquivos, retorna `null`.
 */
function pickRandomShieldId() {
  const n = countTeamShields();
  if (n <= 0) return null;
  return Math.floor(Math.random() * n) + 1;
}

/**
 * Valida id de escudo para persistência (1 … count). `null` limpa o escudo.
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseShieldId(raw) {
  if (raw === null || raw === "") return null;
  const id = Number(raw);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    throw Object.assign(new Error("TEAM_SHIELD_ID_INVALID"), { code: "TEAM_SHIELD_ID_INVALID" });
  }
  const max = countTeamShields();
  if (max <= 0) {
    throw Object.assign(new Error("TEAM_SHIELDS_UNAVAILABLE"), { code: "TEAM_SHIELDS_UNAVAILABLE" });
  }
  if (id > max) {
    throw Object.assign(new Error("TEAM_SHIELD_ID_OUT_OF_RANGE"), {
      code: "TEAM_SHIELD_ID_OUT_OF_RANGE",
      max,
    });
  }
  return id;
}

/**
 * URL pública do escudo (mesmo padrão dos avatars: `/public_assets/team_shields/{id}.webp`).
 */
function teamShieldPublicUrl(shieldId) {
  if (shieldId === null || shieldId === undefined) return null;
  const n = Number(shieldId);
  if (!Number.isFinite(n) || n < 1) return null;
  return `/public_assets/team_shields/${n}.webp`;
}

module.exports = {
  TEAM_SHIELDS_DIR,
  countTeamShields,
  pickRandomShieldId,
  parseShieldId,
  teamShieldPublicUrl,
};
