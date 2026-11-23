FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
ENV NODE_OPTIONS=--max-old-space-size=384

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY . .
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["npm", "start"]
