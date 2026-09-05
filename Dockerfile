# ── Stage 1: Install dependencies ──────────────────────────────────────────
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package*.json .npmrc* ./
RUN npm ci

# ── Stage 2: Build ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ARG GIT_SHA=unknown
ENV NEXT_TELEMETRY_DISABLED=1
ENV GIT_SHA=${GIT_SHA}
RUN npm run build

# ── Stage 3: Production runner ──────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# libc6-compat needed for native packages (e.g. sharp) on Alpine musl
# ffmpeg: provides both ffmpeg (extractPoster, generateLoopClip) and ffprobe (probeDuration)
# postgresql16-client + rsync + bash: needed by scripts/backup (the "backup" service
# in docker-compose.yml runs the same image with these scripts as its command)
RUN apk add --no-cache libc6-compat ffmpeg postgresql16-client rsync bash

RUN addgroup --system --gid 1001 nodejs
RUN adduser  --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# Schema für Auto-Migration beim ersten Start — path must match migrate.ts: join(cwd, 'src/lib/db/schema.sql')
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/db/schema.sql ./src/lib/db/schema.sql
# Runtime scripts: thumbnail backfill (run manually) and the nightly backup
# chain (run by the "backup" service in docker-compose.yml, same image).
COPY --from=builder --chown=nextjs:nodejs /app/scripts/regenerate-thumbnails.mjs ./scripts/regenerate-thumbnails.mjs
COPY --from=builder --chown=nextjs:nodejs /app/scripts/backup ./scripts/backup
RUN chmod +x ./scripts/backup/*.sh
# Entrypoint füllt SESSION_SECRET/DATABASE_URL aus dem Secrets-Volume nach (Compose init-Dienst)
COPY --from=builder --chown=nextjs:nodejs /app/docker-entrypoint.sh ./docker-entrypoint.sh

# Media volume mount point
RUN mkdir -p /app/public/media && chown nextjs:nodejs /app/public/media

# GIT_SHA baked in at build time via --build-arg; exposed by /api/health for release verification
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}

USER nextjs
EXPOSE 4000
ENV PORT=4000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
