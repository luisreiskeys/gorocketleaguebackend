/**
 * Gera uma cópia leve de player_profiles.csv:
 * - Remove todas as linhas em que current_club_name = "Retired"
 * - Remove colunas que não precisamos (slug, dados de contrato, etc.)
 *
 * Saída: player_profiles_clean.csv na raiz do projeto.
 *
 * Uso (na raiz do projeto, fora do container):
 *   node backend/scripts/clean-player-profiles.js
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");

// Considerando que este script está em backend/scripts/
const ROOT_DIR = path.join(__dirname, "..", "..");
const SRC_PATH = path.join(ROOT_DIR, "player_profiles.csv");
const OUT_PATH = path.join(ROOT_DIR, "player_profiles_clean.csv");

// Colunas a remover (mapeadas pelos nomes do header do CSV)
const DROP_COLS = new Set([
  "player_slug",
  "date_of_birth",
  "place_of_birth",
  "height",
  "position",
  "main_position",
  "foot",
  "current_club_id",
  "current_club_name",
  "joined",
  "contract_expires",
  "name_in_home_country",
  "outfitter",
  "social_media_url",
  "player_agent_id",
  "player_agent_name",
  "contract_option",
  "date_of_last_contract_extension",
  "on_loan_from_club_id",
  "on_loan_from_club_name",
  "contract_there_expires",
  "second_club_url",
  "second_club_name",
  "third_club_url",
  "third_club_name",
  "fourth_club_url",
  "fourth_club_name",
  "date_of_death",
]);

function main() {
  if (!fs.existsSync(SRC_PATH)) {
    console.error(
      `[clean-player-profiles] Arquivo de origem não encontrado: ${SRC_PATH}`
    );
    process.exit(1);
  }

  const content = fs.readFileSync(SRC_PATH, "utf8");
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const allColumns = Object.keys(rows[0] || {});
  const keepColumns = allColumns.filter((c) => !DROP_COLS.has(c));

  let removedRetired = 0;
  let written = 0;

  const out = fs.createWriteStream(OUT_PATH);
  out.write(keepColumns.join(",") + "\n");

  for (const row of rows) {
    const club = (row.current_club_name || "").trim().toLowerCase();
    if (club === "retired") {
      removedRetired += 1;
      continue;
    }

    const filtered = keepColumns.map((c) => (row[c] ?? "").toString().replace(/\r?\n/g, " "));
    out.write(filtered.join(",") + "\n");
    written += 1;
  }

  out.end();

  console.log(
    `[clean-player-profiles] Gravado ${written} linhas em ${path.basename(
      OUT_PATH
    )}, removidos ${removedRetired} jogadores Retired.`
  );
}

main();

