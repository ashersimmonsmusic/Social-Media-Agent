FROM node:22-slim AS base
WORKDIR /app

# node:*-slim ships without openssl, which Prisma needs to pick the right
# query-engine binary — without it Prisma warns and falls back to an
# openssl-1.1.x engine that doesn't match Debian bookworm's openssl 3.
# ffmpeg/ffprobe do the video work: reading a clip's dimensions, pulling frames
# for the model to look at, and rendering the vertical cut. There is no usable
# pure-JS substitute, so it has to be in the image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
