# syntax=docker/dockerfile:1

# Isti obrazac kao api. Razlika: sluzi na portu 3000 i uz src/server.js
# nosi i staticke datoteke iz src/public/.
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

USER appuser
EXPOSE 3000
CMD ["node", "src/server.js"]
