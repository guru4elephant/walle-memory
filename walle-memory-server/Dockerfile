FROM node:22-alpine AS builder
WORKDIR /app
COPY walle-memory-server/package.json walle-memory-server/package-lock.json walle-memory-server/tsconfig.json ./
COPY walle-memory-server/src ./src
RUN npm ci && npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/dist ./dist
RUN npm ci --omit=dev
RUN mkdir -p /app/data
EXPOSE 3800
CMD ["node", "dist/index.js"]
