import Redis from 'ioredis';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const logger = pino({ level: 'info' });

// Debate topics to seed
const DEBATE_TOPICS = [
  "Pineapple belongs on pizza",
  "Cats are better than dogs", 
  "Is a hotdog a sandwich?",
  "Should toilet paper hang over or under?",
  "Is water wet?",
  "Are birds real or government drones?",
  "Is cereal a soup?",
  "Should you shower in the morning or at night?",
  "Is math invented or discovered?",
  "Would you rather fight 100 duck-sized horses or 1 horse-sized duck?",
  "Is it better to be too hot or too cold?",
  "Should you put milk or cereal first?",
  "Are video games a sport?",
  "Is time travel possible?",
  "Should robots have rights?",
  "Is social media good or bad for society?",
  "Should we colonize Mars?",
  "Is artificial intelligence a threat to humanity?",
  "Should college be free?",
  "Is remote work better than office work?",
  "Should social media platforms be regulated?",
  "Is cryptocurrency the future of money?",
  "Should school start later in the day?",
  "Is it better to live in the city or countryside?",
  "Should everyone learn to code?",
  "Is nuclear energy safe?",
  "Should we explore space or fix Earth first?",
  "Are electric cars better than gas cars?",
  "Should junk food be banned in schools?",
  "Is online learning better than in-person?"
];

async function migrate() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

  try {
    logger.info('Starting migration...');

    // Clear existing topics
    await redis.del('debate:topics');
    logger.info('Cleared existing topics');

    // Add new topics
    if (DEBATE_TOPICS.length > 0) {
      await redis.sadd('debate:topics', ...DEBATE_TOPICS);
      logger.info(`Added ${DEBATE_TOPICS.length} debate topics`);
    }

    // Set up any initial Redis keys
    await redis.set('debate:stats:total_debates', '0');
    await redis.set('debate:stats:active_users', '0');

    // Create indexes for common queries
    await redis.set('debate:version', '1.0.0');
    await redis.set('debate:migrated_at', new Date().toISOString());

    logger.info('Migration completed successfully');

  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrate()
    .then(() => {
      logger.info('Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration script failed:', error);
      process.exit(1);
    });
}

export { migrate };
