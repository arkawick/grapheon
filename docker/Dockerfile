# Grapheon desktop/web app in Docker.
#
# Two useful targets:
#   --target dev   vite dev server, hot reload, source mounted from the host
#   --target prod  static build served by nginx (this is the real deployment
#                  shape: the app is pure static files, there is no backend)
#
# Layout artifacts are NOT committed (they're regenerable), so the image builds
# them from the canonical graphs that ARE committed. That keeps the image
# self-contained: `docker run` works on a fresh clone with nothing else set up.

# ---------------------------------------------------------------- deps -----
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Workspace manifests first, so `npm ci` is cached until a dependency changes.
COPY package.json package-lock.json ./
COPY extract/package.json   extract/
COPY pipeline/package.json  pipeline/
COPY web/package.json       web/
RUN npm ci

# --------------------------------------------------------------- source ----
FROM deps AS source
WORKDIR /app
COPY extract/  extract/
COPY pipeline/ pipeline/
COPY web/      web/
COPY data/     data/

# Regenerate the layout + edge artifacts the app loads. Cheap (~5s) and it
# means the committed canonical graphs are the single source of truth.
RUN node pipeline/build.js --name aeon \
 && node pipeline/build.js --name grapheon

# ------------------------------------------------------------------ dev ----
FROM source AS dev
WORKDIR /app
EXPOSE 5180
# --host binds 0.0.0.0; without it vite listens on loopback INSIDE the
# container and the published port answers nothing.
CMD ["npm", "run", "dev", "--workspace", "web", "--", "--host", "0.0.0.0"]

# ---------------------------------------------------------------- build ----
FROM source AS build
WORKDIR /app
RUN npm run build --workspace web

# ----------------------------------------------------------------- prod ----
FROM nginx:1.27-alpine AS prod
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
