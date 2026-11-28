FROM node:22.23.5-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://localhost:3001/healthz || exit 1
CMD ["node", "server.js"]
