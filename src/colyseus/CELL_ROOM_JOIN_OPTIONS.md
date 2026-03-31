# API da sala "cell" – joinOrCreate e mensagens

Resoluções H3 configuráveis no backend (sem recompilar):
- **H3_RES_USER_CELL** (default 9) – resolução da célula do usuário
- **H3_RES_ROOM_CELL** (default 8) – resolução da célula da sala (parent da user cell)

O frontend deve usar as mesmas resoluções (ex.: 9 e 8) para calcular índices e o parent.

### Obrigatório na prática: `h3RoomCell` = célula da **sala** (ex. res 8)

- **`h3RoomCell`** deve ser o índice H3 na resolução **`H3_RES_ROOM_CELL`** (default **8**): ou seja, o **parent** da área da sala, **não** a célula fina do usuário.
- Calcule: `h3RoomCell = cellToParent(h3UserCell, H3_RES_ROOM_CELL)` com as mesmas resoluções configuradas no app e no backend.
- **Motivo:** `filterBy(["h3RoomCell"])`, flag, captura e coins tratam essa célula como “donos” da mesma instância de sala. Mandar res errada (ex. mesma string que `h3UserCell` em res 9) quebra o desenho esperado; o backend pode ter **fallback** pontual para coins, mas o contrato correto é **sempre** parent na res da sala.

### Coins na sala (spawn, opcional por env)

- **COIN_SPAWN_ENABLED** (default `true`)
- **COIN_SPAWN_MAX_ACTIVE** (default `30`)
- **COIN_SPAWN_INTERVAL_MS** (default `10000`)
- **COIN_SPAWN_MIN_VALUE** / **COIN_SPAWN_MAX_VALUE** (default `1` / `5`)
- **COIN_PICKUP_RADIUS_M** (default `40`)
- **COIN_SPAWN_MIN_FROM_FLAG_M** (default `25`) – evita spawn colado na flag
- **COIN_SPAWN_TTL_MS** (default `120000`) – remove coin não coletado
- **COIN_COLLECT_MAX_PER_MINUTE** (default `30`) – limite por sessão na sala

**Documentação detalhada para cliente / prompt (state, eventos, saldo vs `UserState`):** ver repositório **`docsFront/COINS_ROOM.md`**.

---

## joinOrCreate("cell", options)

```ts
const room = await client.joinOrCreate("cell", {
  userId: string;
  // h3RoomCell: SEMPRE H3_RES_ROOM_CELL (default 8) = parent; NÃO usar a mesma célula fina que h3UserCell.
  h3RoomCell: string;   // ex.: "88a88cdb3dfffff"
  // h3UserCell: H3_RES_USER_CELL (default 9)
  h3UserCell: string;   // ex.: "89a88cdb3dfffff"

  lat: number;
  lng: number;

  fuel: number;
  xp: number;
  level: number;

  username?: string;
  avatarId?: string;
});
```

- **Matchmaking:** o servidor faz `filterBy(["h3RoomCell"])`, então quem enviar o mesmo `h3RoomCell` entra na mesma sala.
- **Obrigatório:** `h3UserCell = latLngToCell(lat, lng, RES_USER_CELL)`, `h3RoomCell = cellToParent(h3UserCell, RES_ROOM_CELL)` (ex. 9 e 8 nos defaults). **Não** envie `h3RoomCell` na resolução do usuário.

---

## updatePosition

Enviar quando a posição (ou célula) do usuário mudar:

```ts
room.send("updatePosition", {
  lat: number,
  lng: number,
  h3UserCell: string,   // índice H3 na resolução do usuário
  fuel: number,
});
```

---

## State sincronizado (room.state.users)

Cada entrada em `state.users` é um usuário com:

- `id`, `username`, `avatarId`, `level`, `xp`, `fuel`, `lat`, `lng`
- `h3UserCell` (string) – célula do usuário na resolução configurada
- `flagsOwned` (number) – quantidade equivalente de flags na base `resRoomCell`
- `ownedAreaKm2` (number) – área total aproximada possuída
- `maxFuel` (number) – capacidade máxima de combustível
- `refillInterval` (number, ms) – duração do ciclo de recarga
- `lastRefillAt` (number timestamp) – início do ciclo atual (ou 0 se inativo)
- `lastFuelUpdateAt` (number timestamp) – último tick de atualização de fuel no backend
- `refillActive` (boolean) – indica se existe ciclo ativo de recarga
- `refillGranted` (number) – quanto de combustível já foi concedido no ciclo atual

---

## State sincronizado (room.state.owner / room.state.flag)

Além de `users`, a sala expõe:

- `state.owner.userId` (string) – dono atual da célula (vazio quando sem dono)
- `state.flag.lat` / `state.flag.lng` (number) – centro da célula da sala (res8 por padrão)
- `state.flag.isCaptured` (boolean) – `false` enquanto livre, `true` quando capturada

---

## Coins na sala (resumo)

- **Economia (HUD / loja):** `room.state.economy` — `{ fuelPurchaseCoinsPerPercent, maxFuel }` para calcular custo de reabastecer combustível com moedas (ver `docsFront/FUEL_PURCHASE_MOBILE.md`).
- **State:** `room.state.coins` (mapa `coinId → { id, lat, lng, value, h3SpawnCell, h3CollideCell, spawnedAt }`). **`h3CollideCell`** está em **`H3_RES_COLLIDE`** (default 12), igual à flag.
- **Coleta automática:** a cada `updatePosition`, se a célula res12 do jogador coincidir com `h3CollideCell` de uma coin → crédito na wallet + `roomCoinGranted` (`via: "collision"`) + `coinCollected`.
- **Opcional:** `room.send("collectCoin", { coinId })` — mesma regra H3 res colisão (`via: "collectCoin"`).
- **Saldo:** não há campo em `UserState` — usar `roomCoinGranted.balance` e/ou `GET /wallet`.

Detalhes, tipos TS, tabela de `reason` e fluxo de UI: **`docsFront/COINS_ROOM.md`**.

### Comprar combustível com moedas (na sala)

- `room.send("purchaseFuel", { idempotencyKey?: string, percentToAdd?: number })`
  - Sem `percentToAdd` → enche até o máximo (cobra todo o % vazio).
  - Com `percentToAdd` → compra só esse **% da capacidade total** (ex.: 32 → +32% do tanque se `maxFuel=100`), limitado ao espaço livre.
- Respostas: `fuelPurchaseGranted` / `fuelPurchaseRejected` (incl. `invalid_percent`)

Especificação completa: **`docsFront/FUEL_PURCHASE_MOBILE.md`**.

---

## Fuel autoritativo (regra importante)

O combustível é calculado no backend.

- O client pode enviar `fuel` em `updatePosition` por compatibilidade, mas o servidor trata apenas como valor informativo (não autoritativo).
- Em cada `updatePosition` / `updateStats`, o backend:
  1. aplica recarga por tempo (se `refillActive`)
  2. desconta consumo por `deltaKm` (quando houver movimento)
  3. sincroniza o valor final em `state.users[*].fuel`
- A recarga usa ciclo com orçamento fixo (`refillAmount`, hoje igual a `maxFuel` por padrão), evitando "ganho infinito" durante movimento contínuo.

---

## changeRoom (servidor → cliente)

Quando o usuário cruza a fronteira da célula, o servidor envia o estado **atual** (já com fuel calculado e posição) para você usar ao entrar na nova sala. Assim não se perde a última atualização ao trocar de sala rápido.

```ts
room.onMessage("changeRoom", (data: {
  newRoom: string;   // "cell:88a88cdb3dfffff"
  fuel: number;      // fuel já calculado pelo servidor — usar ao dar join na nova sala
  lat: number;
  lng: number;
  h3UserCell: string;
  xp: number;
  level: number;
}) => {
  const h3RoomCell = data.newRoom.startsWith("cell:") ? data.newRoom.slice(5) : data.newRoom;
  // Usar data.fuel, data.lat, data.lng, data.h3UserCell, data.xp, data.level ao montar opts do joinOrCreate.
  await client.joinOrCreate("cell", {
    ...opts,
    h3RoomCell,
    h3UserCell: data.h3UserCell,
    fuel: data.fuel,
    lat: data.lat,
    lng: data.lng,
    xp: data.xp,
    level: data.level,
  });
});
```

---

## fuelDepleted (servidor → cliente)

Quando o usuário fica sem combustível, o servidor envia para aquele client:

```ts
room.onMessage("fuelDepleted", (data: {
  fuel: 0;
  maxFuel: number;        // default 100 (parametrizável)
  refillInterval: number; // ms, default 300000 (5 min, parametrizável)
  lastRefillAt: number;   // timestamp de início do ciclo atual
}) => {
  // usar para abrir modal/toast e iniciar animação de recarga
});
```

Observação: o evento é enviado ao zerar (ou ao entrar na sala já zerado). O valor real do fuel deve ser lido do state sincronizado.

---

## flagCaptured (servidor → sala)

Quando uma célula é capturada (por mensagem `captureCell` ou colisão automática), o servidor faz broadcast:

```ts
room.onMessage("flagCaptured", (data: {
  h3RoomCell: string;
  capturedByUserId: string;
  ownerUserId: string;
}) => {
  // use para notificação/efeitos no front
});
```

---

## captureCell (cliente → servidor) [opcional]

O cliente pode solicitar captura explícita:

```ts
room.send("captureCell", {});
```

Também existe captura automática no backend por colisão com a célula da flag em `resCollide` (configurável por env `H3_RES_COLLIDE`, default 12).

---

## Persistência no banco

- **onJoin / onLeave:** o backend grava em `users`: lat, lng, h3_user_cell, h3_room_cell, fuel, xp, level (nomes internos; colunas mantidas compatíveis).
- Ownership de território é persistido em `cell_ownership`.
