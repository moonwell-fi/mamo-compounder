FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Set environment variables
ENV NODE_ENV=production

# Start the cron job script
CMD ["npx", "ts-node", "cron.ts"]