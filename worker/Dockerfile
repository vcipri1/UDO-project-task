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

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

USER appuser
CMD ["node", "src/worker.js"]
