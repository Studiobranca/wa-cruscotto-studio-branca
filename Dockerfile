FROM node:18-alpine

WORKDIR /app

# Copia package files e installa solo dipendenze production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ARG per invalidare la cache del layer dist/
ARG CACHEBUST=1788460453

# Copia il codice pre-compilato
COPY dist/ ./dist/

# Esposizione porta
EXPOSE 3000

# Avvia il server
CMD ["node", "dist/index.cjs"]
