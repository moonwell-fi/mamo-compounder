# Mamo Compounder

A service that monitors and compounds rewards for Mamo strategies on the Base network.

## Project Overview

This project is a TypeScript application that:

1. Fetches strategies from the Mamo indexer
2. Checks for available rewards for each strategy
3. Claims rewards when they exceed a configured threshold
4. Optionally swaps tokens using CoW Swap

## Deployment Options

### Cloudflare Workers (Original)

The project was originally designed to run on Cloudflare Workers with scheduled triggers.

To deploy to Cloudflare Workers:

```bash
npm run deploy
```

### Railway (Docker Deployment)

The project can also be deployed to Railway using Docker for consistent builds and easy deployment.

#### Docker Deployment Steps

1. **Fork or clone this repository**

2. **Create a new project on Railway**
   - Go to [Railway Dashboard](https://railway.app/dashboard)
   - Click "New Project" and select "Deploy from GitHub repo"
   - Connect your GitHub repository

3. **Configure the deployment**
   - Railway will automatically detect the Dockerfile
   - Select "Docker" as the deployment method

4. **Set required environment variables**
   - Go to the Variables tab in your Railway project
   - Add the following variables:
     - `BASE_RPC_URL`: Base network RPC URL
     - `PRIVATE_KEY`: Private key for transaction signing
     - `MIN_USD_VALUE_THRESHOLD`: Minimum USD value threshold for claiming rewards
     - `CRON_SCHEDULE`: Cron schedule for running the compounder job (default: `*/15 * * * *`)
     - `PORT`: Port for the web server (default: `3000`)

5. **Deploy**
   - Railway will automatically build and deploy your Docker container
   - You can monitor the deployment in the Railway dashboard

## Local Development

### Prerequisites

- Node.js 18 or later
- npm

### For Cloudflare Workers

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

### For Docker (Railway)

```bash
# Build the Docker image
docker build -t mamo-compounder .

# Run the Docker container
docker run -p 3000:3000 --env-file .env.railway mamo-compounder
```

## API Endpoints

- `GET /`: Health check endpoint
- `POST /trigger-job`: Manually trigger the compounder job

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_RPC_URL` | Base network RPC URL | Required |
| `PRIVATE_KEY` | Private key for transaction signing | Required |
| `MIN_USD_VALUE_THRESHOLD` | Minimum USD value threshold for claiming rewards | Required |
| `CRON_SCHEDULE` | Cron schedule for running the compounder job | `*/15 * * * *` (every 15 minutes) |
| `PORT` | Port for the web server | `3000` |

## Architecture

The project uses a dual architecture approach:

1. **Cloudflare Workers**: The original implementation using Cloudflare's scheduled triggers
2. **Docker Container**: A containerized Express server that provides API endpoints and uses node-cron for scheduling

This allows the same core logic to be deployed to either platform with minimal changes.

## Troubleshooting

If you encounter issues with the Docker deployment:

1. Check the Railway logs for specific error messages
2. Verify that all required environment variables are set correctly
3. Make sure your private key has sufficient funds for transactions