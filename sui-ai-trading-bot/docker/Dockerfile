FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./
COPY docker/healthcheck.mjs ./docker/healthcheck.mjs
RUN pnpm install --frozen-lockfile && pnpm build && mkdir -p /app/data /app/validation /app/reports && chown -R node:node /app/data /app/validation /app/reports
ENV HOST=0.0.0.0 MODE=PAPER DATABASE_PATH=/app/data/bot.sqlite
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node", "docker/healthcheck.mjs"]
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
