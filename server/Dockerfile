FROM node:24-alpine
RUN apk add --no-cache ffmpeg
# The build context is server/ only, so the workspace pnpm-lock.yaml is not visible here:
# dependencies resolve from package.json ranges (--no-lockfile). pnpm is pinned to the root version.
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json ./
RUN pnpm install --prod --no-lockfile
COPY index.js openapi.json ./
COPY lib ./lib
COPY public ./public
EXPOSE 3000
CMD ["node", "index.js"]
