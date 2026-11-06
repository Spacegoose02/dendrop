# Dendrop server image (API, gateway and web client).
# Build: docker build -t dendrop .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/theme/package.json packages/theme/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY packages/theme packages/theme
COPY packages/server packages/server
COPY packages/web packages/web
RUN npx tsc -b packages/shared packages/server && npm run build -w @dendrop/web

FROM node:22-alpine
LABEL org.opencontainers.image.title="Dendrop" \
      org.opencontainers.image.description="Private, self-hosted chat for family and friends" \
      org.opencontainers.image.source="https://github.com/Spacegoose02/dendrop"
ENV NODE_ENV=production \
    PUID=99 \
    PGID=100
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/theme/package.json packages/theme/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/desktop/package.json packages/desktop/
RUN npm ci --omit=dev --ignore-scripts --workspace @dendrop/server --workspace @dendrop/shared \
    && npm cache clean --force
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist/src packages/server/dist/src
COPY --from=build /app/packages/web/dist packages/web/dist
COPY docker-entrypoint.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod 755 /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${DENDROP_PORT:-8080}/api/health" >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/src/index.js"]
