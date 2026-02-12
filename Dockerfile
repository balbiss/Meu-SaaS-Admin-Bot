FROM node:22-alpine

WORKDIR /app

# Install dependencies first (caching layer)
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Expose port (Internal in Docker network)
EXPOSE 8788

# Start server
CMD ["node", "server.mjs"]
