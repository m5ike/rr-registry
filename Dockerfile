# RR Registry - web backend server image. Maintainer: m5ike
FROM node:22-alpine

LABEL org.opencontainers.image.title="rr-registry" \
      org.opencontainers.image.description="RR Registry - npm compatible package registry with routing proxy, cache and management API" \
      org.opencontainers.image.authors="m5ike"

# git + git-daemon (git http-backend) serve git repositories over HTTP
RUN apk add --no-cache bash curl jq tini git git-daemon bzip2

WORKDIR /app
COPY VERSION ./
COPY api ./api
COPY server ./server
COPY web ./web
COPY clients ./clients
COPY tools ./tools
COPY docs ./docs
COPY README.md ./
# AI Tools Portal manifest, served at /.well-known/portal-app.json
COPY portal.app.json ./

# "compile" step: generate client libraries from api/spec.json and pack client packages
RUN node tools/build.js && mkdir -p /data && chown -R node:node /data /app/dist /app/docs

ENV RR_DATA_DIR=/data \
    RR_PORT=4873 \
    RR_SSH_PORT=2222 \
    RR_HOST=0.0.0.0 \
    NODE_ENV=production

USER node
VOLUME ["/data"]
EXPOSE 4873 2222

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${RR_PORT}/-/ping" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/bin/rr-server.js"]
