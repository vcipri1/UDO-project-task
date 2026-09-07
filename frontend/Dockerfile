# syntax=docker/dockerfile:1

# Isti obrazac kao api. Razlika: sluzi na portu 3000 i uz src/server.js
# nosi i staticke datoteke iz src/public/.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# Korisnik dobiva EKSPLICITAN numericki UID. Kubernetes ne moze provjeriti
# je li korisnik zadan imenom root ili ne, pa 'runAsNonRoot: true' u manifestu
# radi samo ako je UID poznat broj.
RUN addgroup -g 10001 -S appgroup && adduser -u 10001 -S -G appgroup appuser

# HARDENING: iz runtime slike uklanjamo npm CLI.
# Aplikacija se pokrece s 'node src/server.js' i npm joj u radu ne treba -
# potreban je bio samo u builder stageu, koji ne zavrsava u finalnoj slici.
# Time iz slike nestaje i ranjivi paket 'tar' koji npm nosi sa sobom
# (CVE-2026-59873, CRITICAL), a napadna povrsina se dodatno smanjuje.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm \
           /usr/local/bin/npx

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

USER 10001
EXPOSE 3000
CMD ["node", "src/server.js"]
