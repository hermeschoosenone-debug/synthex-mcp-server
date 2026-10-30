# syntax=docker/dockerfile:1

# ---- build stage ------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies from the lockfile first so the layer caches.
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src

RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/src/generated ./src/generated

# Run unprivileged.
USER node

# Default to the streamable HTTP transport on 8080.
EXPOSE 8080

# NOTE: the payer private key is NEVER baked into the image. Pass it at run
# time: docker run -e SYNTHX_PAYER_PRIVATE_KEY=0x... -e SYNTHX_ALLOW_LIVE_SPEND=1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--http", "--port", "8080"]
