// Links the bot to you: prints a one-time code; send "/start <code>" to your bot in Telegram.
// Works against the database in .env (Turso) or the local data/ database.
//   node --no-warnings scripts/pair.ts
import crypto from 'node:crypto';
import { config } from '../server/config.ts';
const { kvGet, kvSet } = await import('../server/db.ts');
void config;
if (kvGet('tg:owner')) {
  console.log('The bot is already linked to a Telegram account. To re-link, clear it first:');
  console.log('  node --no-warnings scripts/pair.ts --reset');
  if (!process.argv.includes('--reset')) process.exit(0);
  kvSet('tg:owner', '');
}
const code = String(crypto.randomInt(100000, 999999));
kvSet('tg:pair', code);
console.log(`\nSend this to your bot in Telegram:\n\n  /start ${code}\n`);
