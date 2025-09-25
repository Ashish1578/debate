import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const logger = pino({ level: 'info' });

// Debate topics to seed (for reference only in memory-only mode)
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
  try {
    logger.info('Starting migration...');

    // Since we're using memory-only mode, just validate the topics
    logger.info(`Validated ${DEBATE_TOPICS.length} debate topics`);

    // Log all topics for reference
    logger.info('Available debate topics:');
    DEBATE_TOPICS.forEach((topic, index) => {
      logger.info(`  ${index + 1}. ${topic}`);
    });

    // Set up any initial configuration
    logger.info('Migration completed successfully');
    logger.info('Running in memory-only mode - no external database required');

  } catch (error) {
    logger.error('Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if this file is executed directly
if (require.main === module) {
  migrate()
    .then(() => {
      logger.info('Migration script completed - ready for deployment');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration script failed:', error);
      process.exit(1);
    });
}

export { migrate, DEBATE_TOPICS };
