# syntax=docker/dockerfile:1

# Isti obrazac kao api. Razlika: worker nema HTTP sucelje, pa nema ni EXPOSE,
# a ulazna tocka je src/worker.js.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

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

USER appuser
CMD ["node", "src/worker.js"]
