# syntax=docker/dockerfile:1
# Multi-stage build for the assignment. The runtime image only needs the
# built Next.js output and the production node_modules; dev deps are
# pruned in the builder stage.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# sharp + tesseract need a few shared libs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/drizzle.config.json ./drizzle.config.json
COPY --from=builder /app/storage ./storage
EXPOSE 3000
CMD ["npm", "start"]
