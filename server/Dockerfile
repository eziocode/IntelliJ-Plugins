# crm-index server: runs anywhere with Docker (VM, internal container platform). Needs a persistent volume at /data.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY deploy ./deploy
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENV DATA_DIR=/data REPO_NAME=zohocrm MIRROR_DIR=/data/mirror/zohocrm.git PORT=8787 REMOTE_LIST=1
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["docker-entrypoint.sh"]
