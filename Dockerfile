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

# Pinned, not `22-alpine`: a floating tag resolved at image-build time while CI
# resolved its own Node independently, so the two could run different patch
# releases with nothing saying so. KEEP IN SYNC WITH .nvmrc — Docker cannot read
# that file from a FROM line, so this is the one place the value is duplicated.
ARG NODE_VERSION=22.23.2

# Overriding the bundled npm is deliberate. Node 22 LTS ships npm 10.9.8, and a
# lockfile written by npm 11 is rejected outright by npm 10 (EUSAGE, missing
# @emnapi/* entries) — which is what broke CI for a month. One npm version now
# runs everywhere: here, in CI, and on the development machine, where
# package.json's `devEngines` enforces it. Exact rather than a range, so an
# image build is reproducible.
ARG NPM_VERSION=11.6.2

# --- dependencies ------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS deps
ARG NPM_VERSION
WORKDIR /app

RUN npm i -g npm@${NPM_VERSION}

# Only the manifests, so this layer is cached until a dependency actually
# changes rather than on every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# --- build -------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS builder
ARG NPM_VERSION
WORKDIR /app

# Also here, not only in `deps`. `devEngines` with onFail:error refuses EVERY
# npm command, `npm run build` included, so a builder stage on the bundled npm
# 10 fails the build outright rather than merely warning.
RUN npm i -g npm@${NPM_VERSION}

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# The build has no database and no secrets, and must not require them. src/env.ts
# validates at boot instead, which is the moment the values genuinely have to be
# right. Without this the image cannot be built in CI at all.
ENV SKIP_ENV_VALIDATION=1

RUN npm run build

# --- runtime -----------------------------------------------------------------
# No npm in the runtime stage at all, by design — see the header.
FROM node:${NODE_VERSION}-alpine AS runner
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
