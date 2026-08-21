FROM node:24-bookworm-slim

ARG PI_VERSION=0.84.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

RUN mkdir -p /workspace /session \
    && chown -R node:node /workspace /session

USER node
WORKDIR /workspace

ENV PI_OFFLINE=1

CMD ["pi", "--version"]
