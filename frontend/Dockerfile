# Stap 1: Three.js (3D-weergave) ophalen uit npm
FROM node:22-alpine AS vendor
WORKDIR /v
RUN npm install --no-audit --no-fund three@0.159.0

# Stap 2: nginx met de game
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY public/ /usr/share/nginx/html/
COPY --from=vendor /v/node_modules/three/build/three.min.js /usr/share/nginx/html/vendor/three.min.js

EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
