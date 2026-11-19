FROM oven/bun:1.4.4-debian
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk fonts-dejavu-core zip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/web/package.json apps/web/bun.lock ./apps/web/
RUN cd apps/web && bun install --frozen-lockfile
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN cd apps/web && bun run build
COPY apps/server/package.json apps/server/bun.lock ./apps/server/
RUN cd apps/server && bun install --frozen-lockfile --production
COPY packages/shared ./packages/shared
COPY apps/server/src ./apps/server/src
ENV NODE_ENV=production
ENV PORT=8788
ENV APP_DATA_DIR=/data
RUN mkdir -p /data && chown bun:bun /data
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s CMD bun -e "const r=await fetch('http://127.0.0.1:'+process.env.PORT+'/api/health');if(!r.ok)process.exit(1)"
CMD ["bun", "run", "apps/server/src/index.ts"]
