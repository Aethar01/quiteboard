FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./
COPY public ./public

RUN mkdir -p /app/data/boards /app/data/assets

EXPOSE 3000
VOLUME ["/app/data"]

CMD ["npm", "start"]
