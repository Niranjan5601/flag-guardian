FROM node:22.23.5-alpine
WORKDIR /app
COPY package.json loadgen.js ./
USER node
CMD ["node", "loadgen.js"]
