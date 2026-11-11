import { join } from 'node:path';
process.env.SOCIAL_ACCOUNTS_FILE = join(__dirname, 'legacy-accounts.fixture.json');
process.env.CONNECTOR_SHARED_SECRET = 'test-only-secret';
process.env.ENABLE_SENDING = 'true';
