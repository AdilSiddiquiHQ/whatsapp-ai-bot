FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=7860
EXPOSE 7860

CMD ["node", "--max-old-space-size=320", "server.mjs"]
