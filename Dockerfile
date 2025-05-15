FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Expose the port
EXPOSE 3000

# Set environment variables
ENV NODE_ENV=production

# Start the application using ts-node
CMD ["npx", "ts-node", "server.ts"]