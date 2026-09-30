FROM node:22-alpine AS builder
WORKDIR /app
COPY walle-memory-server/package.json walle-memory-server/tsconfig.json ./
COPY walle-memory-server/src ./src
RUN npm install && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
RUN npm install --omit=dev
RUN mkdir -p /app/data
EXPOSE 3800
CMD ["node", "dist/index.js"]
