# PDF Tools Pro — runs the Express server with qpdf available on PATH.
FROM node:20-slim

# qpdf is the external binary server.js shells out to.
RUN apt-get update \
    && apt-get install -y --no-install-recommends qpdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better build caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Render (and most hosts) inject PORT; server.js already reads process.env.PORT.
EXPOSE 3000

CMD ["node", "server.js"]
