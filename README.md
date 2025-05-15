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

The project can also be deployed to Railway using Docker for consistent builds and easy deployment with Railway's built-in cron job system.

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

5. **Configure the cron schedule**
   - Go to the Settings tab in your Railway project
   - Under "Cron", set your desired schedule (e.g., `*/15 * * * *` for every 15 minutes)
   - Railway will automatically run the container on this schedule

6. **Deploy**
   - Railway will automatically build and deploy your Docker container
   - The container will run on the specified schedule, execute the task, and then exit

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

### For Railway Cron Job

```bash
# Install dependencies
npm install

# Run the cron job script directly
npm start
```

### For Docker

```bash
# Build the Docker image
docker build -t mamo-compounder .

# Run the Docker container
docker run --env-file .env.railway mamo-compounder
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_RPC_URL` | Base network RPC URL | Required |
| `PRIVATE_KEY` | Private key for transaction signing | Required |
| `MIN_USD_VALUE_THRESHOLD` | Minimum USD value threshold for claiming rewards | Required |

## Architecture

The project uses a dual architecture approach:

1. **Cloudflare Workers**: The original implementation using Cloudflare's scheduled triggers
2. **Railway Cron Job**: A containerized script that runs on a schedule, executes the task, and then exits

This allows the same core logic to be deployed to either platform with minimal changes.

## How Railway Cron Jobs Work

Railway's cron job system:

1. Executes the container's start command on the specified schedule
2. Expects the process to complete its task and exit
3. Automatically handles scheduling without requiring a persistent server
4. Skips new executions if a previous job is still running

This approach is more efficient than running a persistent server with a scheduling library, as it only consumes resources when the job is actually running.

## Troubleshooting

If you encounter issues with the Railway deployment:

1. Check the Railway logs for specific error messages
2. Verify that all required environment variables are set correctly
3. Make sure your private key has sufficient funds for transactions
4. Ensure the cron job is properly configured in the Railway dashboard