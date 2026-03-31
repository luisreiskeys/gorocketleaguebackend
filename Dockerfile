# Usa Node 24 Alpine (leve e segura)
FROM node:24-alpine

# Instalar git (necessário para algumas dependências npm)
RUN apk add --no-cache git

# Criar usuário não-root para segurança
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Diretório de trabalho
WORKDIR /app

# URL falsa apenas para permitir que `prisma generate` rode no build.
# Em runtime, a URL correta é montada a partir dos Docker secrets em `src/db/prisma.js`.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/appdb"

# Copia apenas arquivos de dependência e schema do Prisma primeiro (melhora cache)
COPY package*.json ./
COPY prisma ./prisma

# Instala dependências (postinstall já consegue rodar `prisma generate`)
RUN npm install --omit=dev

# Copia o restante do código
COPY . .

# Entrypoint monta DATABASE_URL dos secrets para Prisma CLI (db push, etc.)
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Ajusta permissões
RUN chown -R appuser:appgroup /app

# Muda para usuário não-root
USER appuser

# Garante que o processo rode como root (necessário para ler Docker secrets em /run/secrets)
USER root

# Expõe portas: 3000 = Fastify (API), 3001 = Colyseus (matchmake/ws)
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
