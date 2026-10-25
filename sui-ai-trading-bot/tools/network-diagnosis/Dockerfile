FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
WORKDIR /diag
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY *.mjs ./
USER node
ENTRYPOINT ["node", "/diag/cli.mjs"]
# A default invocation prints a plan only. It never makes a diagnostic request.
CMD []
