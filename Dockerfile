FROM node:20-alpine

RUN apk add --no-cache curl git

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

ENV NODE_ENV=production

EXPOSE 8090

CMD ["node", "scripts/docker-entry.mjs"]
