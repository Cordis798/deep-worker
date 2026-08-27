FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY pi-runner/package.json pi-runner/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# The image executes the same compiled SDK adapter as Host. No global CLI or RPC
# entrypoint is installed; the only process boundary is the neutral worker IPC.
COPY shared/dist shared/dist
COPY pi-runner/dist pi-runner/dist

RUN mkdir -p /workspace /session \
    && chown -R node:node /app /workspace /session

USER node
WORKDIR /workspace

ENV PI_OFFLINE=1

CMD ["node", "/app/pi-runner/dist/pi-sdk-worker.js"]
