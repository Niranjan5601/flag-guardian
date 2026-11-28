FROM node:22.23.5-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.5-alpine
WORKDIR /app
ENV NODE_ENV=production
# Inside a container, listen on all of the container's interfaces: Docker's port publishing
# decides what is reachable from outside (compose binds it to 127.0.0.1). Outside Docker the
# CLI default stays 127.0.0.1.
ENV GUARDIAN_HOST=0.0.0.0
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY src/ui ./src/ui
# Run as the image's unprivileged "node" user. /data is created here so a fresh named volume
# inherits node ownership (an existing root-owned volume needs a one-time chown, see README).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
# 127.0.0.1, not localhost: busybox wget may try ::1 first, and Guardian listens on IPv4.
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["run"]
