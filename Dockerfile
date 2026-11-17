# Self-hosted lifestats: one container, SQLite in /app/data (mount a volume) or Turso via TURSO_DATABASE_URL.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:cloud

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/api ./api
COPY selfhost ./selfhost
COPY server ./server
COPY scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--no-warnings", "selfhost/server.mjs"]
