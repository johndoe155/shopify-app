# Production image for Render (or any Docker host).
# Build:  docker build -t india-legal-mrp .
# Run:    docker run -p 10000:10000 --env-file .env.production india-legal-mrp
FROM node:22-bookworm-slim

# Prisma's query engine needs OpenSSL; ca-certificates lets the app reach Shopify and Neon over TLS.
RUN apt-get update -y \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first so Docker can cache this layer. The Prisma schema is
# copied before `npm ci` because @prisma/client generates itself on install.
# Dev dependencies are kept on purpose: the build needs Vite and React Router,
# and start-up runs `prisma migrate deploy`, which needs the Prisma CLI.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
# Render sets PORT itself (10000 by default); react-router-serve reads it.
EXPOSE 10000

RUN chown -R node:node /app
USER node

# Apply pending database migrations, then serve the production build.
# Use the DIRECT (non-pooler) Neon connection string for DATABASE_URL: the schema
# has no directUrl, so migrations would otherwise run through the pooler.
CMD ["sh", "-c", "npx prisma migrate deploy && npm start"]
