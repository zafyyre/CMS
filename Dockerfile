# syntax=docker/dockerfile:1

# The application image.
#
# Three stages, so the runtime image contains no source, no dev dependencies and
# no package manager: dependencies, build, then a runtime that receives only the
# traced output. That is roughly a tenth of the size of a naive image and, more
# to the point, a much smaller thing to have opinions about in a security review.
#
# The local Postgres and Redis in docker-compose.yml are a DEVELOPMENT stack and
# are deliberately not referenced here. A deployed environment gets managed
# instances of both, injected as POSTGRES_URL and REDIS_URL.

# --- dependencies ------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# --- build -------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The build has no database and no secrets, and must not require them. src/env.ts
# validates at boot instead, which is the moment the values genuinely have to be
# right. Without this the image cannot be built in CI at all.
ENV SKIP_ENV_VALIDATION=1

RUN npm run build

# --- runtime -----------------------------------------------------------------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Never root. A container escape is a different conversation from a container
# escape as uid 0.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

# `server.js` serves these two only if they sit beside it — see the note in
# next.config.ts and Next's `output` documentation.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# Bind to every interface: the platform's router reaches the container over its
# own network, and a process bound to 127.0.0.1 is invisible to it.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# The same probe the platform health check uses. Node's own fetch, so the image
# needs neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
