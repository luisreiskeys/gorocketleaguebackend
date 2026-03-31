"use strict";

const roomRegistry = require("../colyseus/roomRegistry");

const HTML_PAGE = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Salas Colyseus</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 1rem; background: #1a1a2e; color: #eee; }
    h1 { margin: 0 0 0.5rem; font-size: 1.25rem; }
    .meta { color: #888; font-size: 0.875rem; margin-bottom: 1rem; }
    .room { background: #16213e; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; border: 1px solid #0f3460; }
    .room h2 { margin: 0 0 0.25rem; font-size: 1rem; color: #e94560; }
    .room .cell { color: #b8d4e8; font-family: monospace; font-size: 0.85rem; font-weight: 600; margin-bottom: 0.5rem; }
    .cell-state { font-size: 0.8rem; color: #a2b5ff; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
    .cell-state .pill { background: #0f3460; border: 1px solid #1e4d85; border-radius: 999px; padding: 0.15rem 0.55rem; font-family: monospace; font-size: 0.75rem; }
    .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; margin-right: 0.35rem; }
    .dot.ok { background: #2ecc71; }
    .dot.off { background: #e94560; }
    .users { margin-top: 0.5rem; }
    .user { background: #0f3460; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 0.4rem; font-size: 0.9rem; display: flex; align-items: center; gap: 0.6rem; }
    .user-avatar-wrap { position: relative; flex-shrink: 0; }
    .user-avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; background: #1a1a2e; display: block; }
    .user-avatar-placeholder { width: 36px; height: 36px; border-radius: 50%; background: #e94560; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 1rem; }
    .user-name { color: #eee; font-weight: 500; }
    .debug { margin-top: 0.5rem; padding: 0.5rem 0.75rem; border-radius: 6px; background: #0b1020; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.75rem; max-height: 200px; overflow: auto; color: #a2b5ff; }
    .empty { color: #666; font-style: italic; }
    .err { color: #e94560; }
  </style>
</head>
<body>
  <h1>Salas Colyseus (cell)</h1>
  <div id="root">Carregando...</div>
  <script>
    function render(data) {
      const root = document.getElementById('root');
      if (!Array.isArray(data)) { root.innerHTML = '<p class="err">Resposta inválida</p>'; return; }
      if (data.length === 0) { root.innerHTML = '<p class="empty">Nenhuma sala ativa.</p>'; return; }
      root.innerHTML = data.map(function(r) {
        var cs = r.cellState || {};
        var owner = cs.ownerUserId || '';
        var hasFlag = cs.flagLat != null && cs.flagLng != null;
        var isCaptured = !!cs.isCaptured;
        var flagLabel = hasFlag ? (isCaptured ? 'capturada' : 'livre') : 'ausente';
        var flagDot = '<span class="dot ' + (hasFlag ? 'ok' : 'off') + '"></span>';
        var stateHtml =
          '<div class="cell-state">' +
            '<span>' + flagDot + 'flag: <b>' + escape(flagLabel) + '</b></span>' +
            '<span class="pill">owner: ' + escape(owner || 'nenhum') + '</span>' +
            '<span class="pill">lat: ' + escape(cs.flagLat == null ? '-' : String(cs.flagLat)) + '</span>' +
            '<span class="pill">lng: ' + escape(cs.flagLng == null ? '-' : String(cs.flagLng)) + '</span>' +
          '</div>';
        const usersHtml = r.users.length === 0
          ? '<p class="empty">Nenhum usuário</p>'
          : r.users.map(function(u) {
              if (u.error) return '<div class="user err">' + escape(u.error) + '</div>';
              var name = escape(u.username || 'Sem nome');
              var initial = (u.username && u.username[0]) ? u.username[0].toUpperCase() : '?';
              var avatarUrl = '/public_assets/avatars/' + encodeURIComponent(u.avatarId || '') + '.webp';
              var avatarHtml = '<div class="user-avatar-wrap"><img class="user-avatar" src="' + avatarUrl + '" alt="" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\';">' +
                '<span class="user-avatar-placeholder" style="display:none;">' + escape(initial) + '</span></div>';
              return '<div class="user">' + avatarHtml + '<span class="user-name">' + name + '</span></div>';
            }).join('');
        var debug = '<pre class="debug">' + escape(JSON.stringify(r, null, 2)) + '</pre>';
        return '<div class="room"><h2>Room ' + escape(r.roomId) + '</h2><div class="cell">' + escape(r.roomCell) + ' (' + r.userCount + ' usuários)</div>' + stateHtml + '<div class="users">' + usersHtml + '</div>' + debug + '</div>';
      }).join('');
    }
    function escape(s) { return (s == null ? '' : String(s)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function fetchData() {
      fetch('/salasColyseus/dados')
        .then(function(res) { return res.json(); })
        .then(render)
        .catch(function(e) { document.getElementById('root').innerHTML = '<p class="err">Erro: ' + escape(e.message) + '</p>'; });
    }
    fetchData();
    setInterval(fetchData, 500);
  </script>
</body>
</html>
`;

async function salasColyseusRoutes(fastify) {
  fastify.get("/salasColyseus", async (request, reply) => {
    reply.type("text/html; charset=utf-8").send(HTML_PAGE);
  });

  fastify.get("/salasColyseus/dados", async (request, reply) => {
    const data = roomRegistry.getSnapshot();
    reply.send(data);
  });
}

module.exports = salasColyseusRoutes;
