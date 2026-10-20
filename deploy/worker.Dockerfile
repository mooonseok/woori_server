# Server release image, used by both Lightsail instances: the worker runs the
# default CMD and the API overrides it with `node dist/src/main.js`.
# ffmpeg/ffprobe come from the Debian bookworm package (FFmpeg 5.1 with libx264
# and the native AAC encoder); no npm ffmpeg binaries are used. The build fails
# when the worker --check cannot find ffmpeg with libx264/AAC.
# Build it with scripts/release-image.mjs, which exports a commit with
# `git archive` and passes that commit as WOORI_RELEASE (shown by /healthz and
# the image revision label). A plain `docker build` leaves the release unknown.
FROM node:24.12.0-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.27.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && node dist/src/worker/main.js --check
ARG WOORI_RELEASE=""
LABEL org.opencontainers.image.revision="${WOORI_RELEASE}"
ENV NODE_ENV=production WOORI_RELEASE="${WOORI_RELEASE}"
USER node
CMD ["node", "dist/src/worker/main.js"]
