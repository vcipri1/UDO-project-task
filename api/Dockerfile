# syntax=docker/dockerfile:1

# ---------- 1. stage: builder ----------
# Ovdje se instaliraju ovisnosti. Ovaj stage NE zavrsava u finalnoj slici -
# postoji samo zato da nam alati za gradnju ne ostanu u gotovoj slici.
FROM node:22-alpine AS builder
WORKDIR /app

# Kopiramo prvo samo manifeste. Ako se package.json ne promijeni, Docker
# ponovno koristi cache i preskace instalaciju - buildovi su puno brzi.
COPY package*.json ./

# --omit=dev preskace devDependencies (nodemon); u produkciji ih ne trebamo.
RUN npm install --omit=dev

# ---------- 2. stage: runtime ----------
# Cista, minimalna slika u koju prekopiramo samo ono sto aplikacija treba za rad.
FROM node:22-alpine AS runtime
WORKDIR /app

# Sistemski korisnik bez lozinke i bez home direktorija.
# Bez ovoga bi kontejner vrtio kao root - najcesca sigurnosna greska.
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

# Datoteke ostaju u vlasnistvu roota, a appuser ih samo cita. Tako proces
# ne moze prepisati vlastiti kod ni ako ga napadac preuzme.
USER appuser

# EXPOSE je dokumentacija za citatelja i alate - ne otvara port sam po sebi.
EXPOSE 8080

# Exec forma (JSON niz), ne shell forma: proces dobiva PID 1 i uredno
# prima SIGTERM pri gasenju, sto server.js koristi za graceful shutdown.
CMD ["node", "src/server.js"]
