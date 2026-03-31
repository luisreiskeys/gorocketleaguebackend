#!/usr/bin/env node
/**
 * Testa se o Colyseus está no ar: POST no matchmake joinOrCreate/cell.
 * Uso: node scripts/test-colyseus.js [URL]
 * Ex.: node scripts/test-colyseus.js
 *      node scripts/test-colyseus.js http://localhost:3000
 */
const http = require("http");
const https = require("https");

const BASE_URL = process.argv[2] || "http://localhost:3000";

const body = JSON.stringify({
  h3RoomCell: "88a88cdb3dfffff",
  h3UserCell: "89a88cdb3dfffff",
  userId: "test-user-id",
  username: "TestUser",
  avatarId: "1",
  level: 1,
  xp: 0,
  fuel: 100,
  lat: -23.55,
  lng: -46.63,
});

function request(options, bodyString) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === "https:" ? https : http;
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ statusCode: res.statusCode, body: data ? JSON.parse(data) : data });
        } catch {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });
    req.on("error", reject);
    req.setHeader("Content-Type", "application/json");
    req.setHeader("Content-Length", Buffer.byteLength(bodyString));
    req.end(bodyString);
  });
}

async function main() {
  const url = new URL("/matchmake/joinOrCreate/cell", BASE_URL);
  const options = {
    method: "POST",
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname,
  };
  try {
    const res = await request(options, body);
    if (res.statusCode === 200 && res.body && (res.body.roomId || res.body.id)) {
      console.log("OK Colyseus: sala criada/entrada");
      console.log("  roomId:", res.body.roomId || res.body.id);
      console.log("  sessionId:", res.body.sessionId);
      process.exit(0);
    } else if (res.statusCode === 404) {
      console.error("ERRO: rota /matchmake não encontrada (404). Colyseus pode não estar recebendo as requisições.");
      process.exit(1);
    } else {
      console.error("Resposta inesperada:", res.statusCode, res.body);
      process.exit(1);
    }
  } catch (err) {
    console.error("ERRO:", err.message);
    process.exit(1);
  }
}

main();
