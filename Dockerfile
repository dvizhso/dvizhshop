FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8088 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

WORKDIR /app

# Зависимостей нет — копируем только код.
COPY package.json ./
COPY server.mjs bot.mjs ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data/uploads

EXPOSE 8088
VOLUME ["/app/data"]

CMD ["node", "--experimental-sqlite", "server.mjs"]
