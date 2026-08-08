FROM node:22-slim AS base
WORKDIR /app
RUN corepack enable && corepack prepare --activate

# Manifests only, so a source-only change reuses the install layer.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/vc-signer/package.json packages/vc-signer/
COPY service/package.json service/
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm -r build

# A second install rather than a prune: `--prod` is workspace-aware, so the
# workspace link from service to vc-signer survives it.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/vc-signer/package.json packages/vc-signer/
COPY service/package.json service/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=4008
# Manifests and production node_modules, then the compiled output.
COPY --from=prod-deps /app ./
COPY --from=build /app/packages/vc-signer/dist ./packages/vc-signer/dist
COPY --from=build /app/service/dist ./service/dist

EXPOSE 4008
CMD ["node", "service/dist/server.js"]
