# ============================================================
# Dockerfile — Production container
# Build: docker build -t nook-sms-api .
# Run:   docker run -p 3000:3000 --env-file .env nook-sms-api
# ============================================================

# Use official Node.js LTS image
# Alpine = smaller image (5x smaller than full Ubuntu)
FROM node:20-alpine

# Install dumb-init for proper process management
# Without this, Ctrl+C and Docker stop do not work cleanly
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy package files FIRST
# Docker caches this layer — npm install only reruns if package.json changes
COPY package*.json ./

# Install production dependencies only
# --omit=dev skips jest, nodemon, eslint (not needed in production)
RUN npm ci --omit=dev

# Copy application code
COPY src/ ./src/

# Create logs directory
RUN mkdir -p logs

# Use non-root user for security
# Never run production containers as root
RUN addgroup -S nook && adduser -S nook -G nook
RUN chown -R nook:nook /app
USER nook

# Expose port
EXPOSE 3000

# Health check — Docker will restart container if this fails
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start with dumb-init to handle signals properly
CMD ["dumb-init", "node", "src/index.js"]
