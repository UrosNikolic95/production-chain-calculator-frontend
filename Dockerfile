# ---- Build stage ----
FROM node:24-alpine AS builder
WORKDIR /app

# Install dependencies using the lockfile for reproducible builds
COPY package*.json ./
RUN npm ci

# Build the Angular app (production configuration is the default)
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM nginx:alpine AS runner

# SPA routing config (fallback to index.html)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy the compiled browser bundle
COPY --from=builder /app/dist/production-chain-calculator-frontend/browser /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
