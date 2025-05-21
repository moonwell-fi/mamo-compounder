import { Pool } from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Create a PostgreSQL connection pool
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl:
		process.env.NODE_ENV === 'production'
			? {
					rejectUnauthorized: false, // Required for Railway PostgreSQL
			  }
			: false,
});

// Add connection error handling
pool.on('error', (err) => {
	console.error('Unexpected error on idle client', err);
	process.exit(-1);
});

// Interface for position data
export interface Position {
	strategy_address: string;
	split_mtoken: number;
	split_vault: number;
	strategy_type: string;
	last_updated: Date;
	apy: number;
}

/**
 * Initialize the database by creating the positions table if it doesn't exist
 */
export async function initializeDatabase(): Promise<void> {
	let client;
	try {
		// Test the connection first
		console.log('Testing database connection...');
		client = await pool.connect();
		console.log('✅ Database connection successful');

		// Create the positions table if it doesn't exist
		console.log("Creating positions table if it doesn't exist...");
		await client.query(`
      CREATE TABLE IF NOT EXISTS positions (
        strategy_address VARCHAR(42) PRIMARY KEY,
        split_mtoken INTEGER NOT NULL,
        split_vault INTEGER NOT NULL,
        strategy_type VARCHAR(50) NOT NULL,
        last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
        apy NUMERIC(10, 2) NOT NULL
      );
    `);
		console.log('✅ Database initialized successfully');
	} catch (error) {
		console.error('❌ Error initializing database:', error);
		console.error('Database connection details:', {
			url: process.env.DATABASE_URL ? 'Set (value hidden)' : 'Not set',
			ssl: process.env.NODE_ENV === 'production' ? 'Enabled' : 'Disabled',
		});
		throw error;
	} finally {
		if (client) {
			client.release();
		}
	}
}

/**
 * Get a position by strategy address
 * @param strategyAddress The strategy address
 * @returns The position or null if not found
 */
export async function getPosition(strategyAddress: string): Promise<Position | null> {
	try {
		const result = await pool.query('SELECT * FROM positions WHERE strategy_address = $1', [strategyAddress]);

		if (result.rows.length === 0) {
			return null;
		}

		return result.rows[0] as Position;
	} catch (error) {
		console.error(`❌ Error getting position for strategy ${strategyAddress}:`, error);
		throw error;
	}
}

/**
 * Insert a new position
 * @param position The position to insert
 */
export async function insertPosition(position: Position): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO positions 
       (strategy_address, split_mtoken, split_vault, strategy_type, last_updated, apy) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
			[position.strategy_address, position.split_mtoken, position.split_vault, position.strategy_type, position.last_updated, position.apy]
		);
		console.log(`✅ Position inserted for strategy ${position.strategy_address}`);
	} catch (error) {
		console.error(`❌ Error inserting position for strategy ${position.strategy_address}:`, error);
		throw error;
	}
}

/**
 * Update an existing position
 * @param position The position to update
 */
export async function updatePosition(position: Position): Promise<void> {
	try {
		await pool.query(
			`UPDATE positions 
       SET split_mtoken = $2, 
           split_vault = $3, 
           strategy_type = $4, 
           last_updated = $5, 
           apy = $6
       WHERE strategy_address = $1`,
			[position.strategy_address, position.split_mtoken, position.split_vault, position.strategy_type, position.last_updated, position.apy]
		);
		console.log(`✅ Position updated for strategy ${position.strategy_address}`);
	} catch (error) {
		console.error(`❌ Error updating position for strategy ${position.strategy_address}:`, error);
		throw error;
	}
}

/**
 * Check if a position exists
 * @param strategyAddress The strategy address
 * @returns Whether the position exists
 */
export async function positionExists(strategyAddress: string): Promise<boolean> {
	try {
		const result = await pool.query('SELECT 1 FROM positions WHERE strategy_address = $1', [strategyAddress]);
		return result.rows.length > 0;
	} catch (error) {
		console.error(`❌ Error checking if position exists for strategy ${strategyAddress}:`, error);
		throw error;
	}
}

// Export the pool for direct access if needed
export { pool };
