# Migração do frontend – API h3Res8/h3Res9 → h3RoomCell/h3UserCell

O backend passou a usar **h3RoomCell** e **h3UserCell** em toda a API. As resoluções são configuráveis por env no servidor (`H3_RES_USER_CELL`, `H3_RES_ROOM_CELL`); no front você continua usando as mesmas resoluções (ex.: 9 e 8) nos cálculos.

---

## 1. Tipos / interfaces

**Antes:**
```ts
h3Res8: string;
h3Res9: string;
```

**Depois:**
```ts
h3RoomCell: string;   // célula da sala (parent)
h3UserCell: string;   // célula do usuário
```

Atualize `JoinCellOptions`, payloads de `updatePosition` e qualquer tipo que espelhe o state do Colyseus (ex.: `CellUserState`).

---

## 2. joinOrCreate("cell", options)

**Antes:**
```ts
await client.joinOrCreate("cell", {
  userId,
  h3Res8: getRoomCell(h3Res9),
  h3Res9: getUserCell(lat, lng),
  lat, lng, fuel, xp, level, username, avatarId,
});
```

**Depois:**
```ts
await client.joinOrCreate("cell", {
  userId,
  h3RoomCell: getRoomCell(getUserCell(lat, lng)),   // ou cellToParent(h3UserCell, RES_ROOM_CELL)
  h3UserCell: getUserCell(lat, lng),                 // latLngToCell(lat, lng, RES_USER_CELL)
  lat, lng, fuel, xp, level, username, avatarId,
});
```

Ou seja: trocar **h3Res8** → **h3RoomCell** e **h3Res9** → **h3UserCell** nos nomes dos campos. A lógica (getUserCell, getRoomCell / cellToParent) permanece; só os nomes das chaves mudam.

---

## 3. updatePosition

**Antes:**
```ts
room.send("updatePosition", { lat, lng, h3Res9: getUserCell(lat, lng), fuel });
```

**Depois:**
```ts
room.send("updatePosition", { lat, lng, h3UserCell: getUserCell(lat, lng), fuel });
```

---

## 4. State (room.state.users) – outros usuários

**Antes:** você lia `user.h3Res9` (e possivelmente `user.h3Res8` em algum lugar).

**Depois:** o state só expõe **h3UserCell** por usuário:

```ts
// Ao montar lista de outros usuários a partir de room.state
const h3UserCell = user.h3UserCell ?? "";  // era user.h3Res9
```

Atualize qualquer lugar que use `user.h3Res9` ou `user.h3Res8` no state para usar **h3UserCell**. Não existe mais `h3Res8` no state de cada usuário (a sala em si é identificada pelo matchmaking com `h3RoomCell`).

---

## 5. changeRoom – entrar na nova sala

**Antes:**
```ts
const h3Res8FromServer = data.newRoom.startsWith("cell:") ? data.newRoom.slice(5) : data.newRoom;
const optsNewCell = { ...opts, h3Res8: h3Res8FromServer };
await client.joinOrCreate("cell", optsNewCell);
```

**Depois:**
```ts
const h3RoomCellFromServer = data.newRoom.startsWith("cell:") ? data.newRoom.slice(5) : data.newRoom;
const optsNewCell = { ...opts, h3RoomCell: h3RoomCellFromServer };
await client.joinOrCreate("cell", optsNewCell);
```

Ou seja: o conteúdo de `data.newRoom` continua no formato `"cell:88a88cdb3dfffff"`; você só passa a guardar em **h3RoomCell** e a enviar **h3RoomCell** no próximo `joinOrCreate`.

---

## 6. buildJoinOptions / getRoomCell / getUserCell

- **getUserCell(lat, lng)** – deve retornar o índice na **resolução do usuário** (ex.: 9). Pode manter o nome; o importante é usar a resolução correta.
- **getRoomCell(h3UserCell)** – deve retornar o **parent** na resolução da sala (ex.: 8), ou seja, `cellToParent(h3UserCell, RES_ROOM_CELL)`.

Nos objetos de options que você monta para `joinOrCreate`, troque:

- `h3Res8` → **h3RoomCell**
- `h3Res9` → **h3UserCell**

---

## 7. Nomes para debug / UI

Onde você exibe “h3Res8” ou “h3Res9” (labels, logs, painel de debug), pode renomear para “h3RoomCell” e “h3UserCell” para ficar alinhado ao backend.

---

## 8. Resumo rápido

| Onde              | Antes    | Depois      |
|-------------------|----------|-------------|
| Options join      | h3Res8   | h3RoomCell  |
| Options join      | h3Res9   | h3UserCell  |
| updatePosition    | h3Res9   | h3UserCell  |
| state.users[].*   | h3Res9   | h3UserCell  |
| changeRoom → join | h3Res8   | h3RoomCell  |
| Tipos/interface   | h3Res8/9 | h3RoomCell / h3UserCell |

Nenhuma mudança de comportamento de resolução no front: continue usando as mesmas resoluções (ex.: 9 para usuário, 8 para sala); apenas os **nomes dos campos** na API e no state passam a ser **h3RoomCell** e **h3UserCell**.
