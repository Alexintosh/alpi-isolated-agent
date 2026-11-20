# linux/amd64 pilot profile. Publish the resulting image by digest.
FROM node:24-bookworm-slim@sha256:0e2646ab57e77b7a384a0cb59b6815b182c77e1f9c3ba36bd8435bd9c4e6680e

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/alpi/pi
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && install -d -m 0700 -o node -g node /home/node/workspace /home/node/.pi/agent

ENV PATH="/opt/alpi/pi/node_modules/.bin:${PATH}"
ENV PI_CODING_AGENT_DIR=/home/node/.pi/agent
USER node
WORKDIR /home/node/workspace
CMD ["sleep", "infinity"]
