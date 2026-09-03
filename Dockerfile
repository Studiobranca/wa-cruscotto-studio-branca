FROM node:18-alpine

WORKDIR /app

# Copia dist/ PRIMA — questo layer cambia ad ogni build e invalida il successivo
COPY dist/ ./dist/

# Copia package files e installa dipendenze (sempre fresco dopo cambio dist/)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Esposizione porta
EXPOSE 8080

# Avvia il server
CMD ["node", "dist/index.cjs"]
