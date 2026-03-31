# GoRocketLeague Backend

Backend em Node.js (Fastify + Colyseus + Prisma + PostgreSQL) do projeto GoRocketLeague.

Este README foi escrito para servir de guia de onboarding para alunos: como subir o ambiente, aplicar schema do Prisma e onde encontrar a documentação de API.

## Stack

- Node.js 24 (via Docker)
- Fastify (HTTP API)
- Colyseus (tempo real / matchmaking)
- Prisma 7 + PostgreSQL
- Redis (suporte a features de tempo real)

## Estrutura rápida

- `src/server.js`: bootstrap do Fastify + Colyseus
- `src/routes/`: rotas HTTP
- `src/services/`: regras de negócio
- `prisma/schema.prisma`: modelo do banco
- `data/`: assets locais (avatars, escudos, versões)

## Subindo o projeto (recomendado)

Na raiz do projeto (`gorocketleague/`), use Docker Compose:

```bash
docker compose up --build
```

API disponível em:

- `http://localhost:3000`

Healthcheck básico:

```bash
curl http://localhost:3000/
```

Resposta esperada:

```json
{
  "status": "ok",
  "message": "Hello World GoRocketLeague 🚀"
}
```

## Secrets obrigatórios

O `docker-compose.yml` espera os arquivos abaixo em `./secrets/`:

- `db_user.txt`
- `db_password.txt`
- `redis_password.txt`
- `admin_api_token.txt`
- `jwt_secret.txt`
- `google_ios_client_id.txt`
- `google_android_client_id.txt`
- `apple_ios_client_id.txt`
- `apple_android_client_id.txt`
- `pgadmin_password.txt` (se usar profile `tools`)

Sem esses secrets o container do backend não sobe corretamente.


## Principais variáveis de ambiente

- `JWT_SECRET` ou `JWT_SECRET_FILE` (obrigatório para autenticação)
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_DB`
- `POSTGRES_USER` / `POSTGRES_USER_FILE`
- `POSTGRES_PASSWORD` / `POSTGRES_PASSWORD_FILE`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD_FILE`
- `ADMIN_API_TOKEN` / `ADMIN_API_TOKEN_FILE`
- `PLAYERS_PHOTOS_DIR`, `AVATARS_DIR`, `TEAM_SHIELDS_DIR`
- `TEAMS_LEADERBOARD_WIN_COOLDOWN_HOURS`
- `TEAMS_LEADERBOARD_DEBUG_LOG`, `TEAMS_LEADERBOARD_LOG_DIR`

## Autenticação (resumo)

- Rotas de usuário usam JWT Bearer.
- Fluxos de auth estão em `/auth`:
  - `POST /auth/guest`
  - `POST /auth/refresh`
  - `POST /auth/link-google`
  - `POST /auth/link-appleid`
- Rotas administrativas exigem token admin (`ADMIN_API_TOKEN`).

## Mapa de rotas (alto nível)

- Públicas:
  - `GET /`
  - `GET /players/version`
  - `GET /players/versions/:version/download`
- Usuário/time/carteira:
  - rotas de perfil e instâncias
  - `/user/team`, `/user/team/battle-settings`, `/teams/leaderboard`
  - `/wallet`, `/wallet/transactions`, `/wallet/ad-reward`, `/wallet/purchase-fuel`
- Batalhas:
  - `/battle-tiers`
  - `/battles`
  - `/battles/instant-open`
  - `/battles/:id/accept`, `/battles/:id/decline`
- Trocas:
  - rotas de proposta/aceite/cancelamento de trades
- Admin de players:
  - `/admin/players/*`

