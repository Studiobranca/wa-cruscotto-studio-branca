FROM node:18-alpine

WORKDIR /app

# Copia package files e installa dipendenze
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia dist/ e lo script di patch
COPY dist/ ./dist/
COPY patch-and-start.js ./

EXPOSE 8080

# Avvia tramite patcher che risolve subquery correlate
CMD ["node", "/app/patch-and-start.js"]
