FROM node:18-alpine

WORKDIR /app

# Copia dist/ PRIMA (layer che cambia = invalida cache)
COPY dist/ ./dist/

# Copia package files e installa dipendenze
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

EXPOSE 8080

# USA server_patch.cjs con fix conversations + Gemini fallback
CMD ["node", "dist/server_patch.cjs"]
