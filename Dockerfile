FROM node:18-alpine

WORKDIR /app

# Copia package files e installa solo dipendenze production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copia il codice pre-compilato
COPY dist/ ./dist/

# Esposizione porta
EXPOSE 3000

# Avvia il server
CMD ["node", "dist/index.cjs"]
