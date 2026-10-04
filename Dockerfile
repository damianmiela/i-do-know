# I Do! (know): one container, Fastify serves the built client and Socket.IO on one port.
# The image holds only the code and the example content: real content (guests, questions,
# photos, event) and .env never go into it (see .dockerignore).

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

# ---- run ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3210
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
COPY apps/server/package.json apps/server/
COPY packages/shared/package.json packages/shared/
# only the server's runtime packages (fastify, socket.io): the client is already built
RUN npm ci --omit=dev --ignore-scripts -w @idoknow/server && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/client/dist apps/client/dist
COPY content/*.example.json content/
COPY content/photos/example-baby.webp content/photos/
RUN mkdir -p data && chown node:node data content content/photos
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3210/health || exit 1
CMD ["node", "apps/server/dist/index.js"]
