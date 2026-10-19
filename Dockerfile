# syntax=docker/dockerfile:1
# Two stages: compile TypeScript with dev deps, then ship only the output
# and production deps. App Runner runs this image on port 3000.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY server ./server
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# migrate.js and seed.js read these at runtime, relative to their own location.
COPY server/db/sql ./dist/db/sql
COPY public ./public
EXPOSE 3000
USER node
# start = migrate, seed, then serve (see package.json).
CMD ["npm", "run", "start"]
