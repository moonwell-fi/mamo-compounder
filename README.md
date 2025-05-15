# MAMO Compounder

This project handles the compounding of rewards for MAMO strategies.

#### Server-based Implementation

- Runs as a long-lived server process
- Uses internal scheduling to run tasks periodically
- Provides health check and status endpoints
- Continues running after task completion
- Better error handling and recovery
- Can be monitored and scaled more easily

### How to Run

#### Install Dependencies

```bash
npm install
```

#### Run the Server

```bash
npm run dev
```

This will start the server on port 3000 (or the port specified in the PORT environment variable).

### API Endpoints

- `/health` - Returns the server health status
- `/status` - Returns the status of all registered periodic tasks

### Environment Variables

- `PORT` - The port to run the server on (default: 3000)
- `BASE_RPC_URL` - The RPC URL for the Base network
- `PRIVATE_KEY` - The private key for the wallet that will execute transactions
- `MIN_USD_VALUE_THRESHOLD` - The minimum USD value threshold for processing rewards

### Periodic Task Implementation

The server uses a simple periodic task scheduler that runs tasks at specified intervals:

```typescript
// Define a periodic task
periodic({
  interval: 1000 * 60 * 5, // 5 minutes
  fn: processRewards,
  prefix: '[MAMO Compounder]'
});
```

This registers a task to run the `processRewards` function every 5 minutes.

### Benefits of the Server Approach

1. **Reliability**: The server continues running even if individual tasks fail
2. **Monitoring**: Health check and status endpoints make it easier to monitor
3. **Flexibility**: Tasks can be dynamically registered and managed
4. **Resource Efficiency**: A single process handles multiple scheduled tasks
5. **Simplified Deployment**: No need for external scheduling tools

### Implementation Notes

The server implementation maintains the same core business logic as the cron implementation, but wraps it in a more robust and maintainable structure. The key components are:

1. **Express Server**: Provides HTTP endpoints for health checks and status
2. **Task Scheduler**: Manages the execution of periodic tasks
3. **Periodic Task Registry**: Stores and tracks registered tasks
4. **Error Handling**: Improved error handling to prevent process crashes

This approach is more suitable for production environments and provides better observability and reliability.