# Worker image (W07-3 video transcoding). ffmpeg/ffprobe come from the Debian
# bookworm package (FFmpeg 5.1 with libx264 and the native AAC encoder); no npm
# ffmpeg binaries are used. Point only the Railway worker service at this file
# (RAILWAY_DOCKERFILE_PATH=deploy/worker.Dockerfile); the API needs no ffmpeg.
# The build fails when the worker --check cannot find ffmpeg with libx264/AAC.
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
ENV NODE_ENV=production
USER node
CMD ["node", "dist/src/worker/main.js"]
