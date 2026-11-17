// lifestats daemon: collects data locally and serves it through the Telegram bot.
// The bot long-polls Telegram; the Mini App server listens on 127.0.0.1 only and is reached
// through a Cloudflare quick tunnel (every API call must carry the owner's Telegram signature).
// Data comes from the iCloud Drive folder (Health Auto Export), data/inbox, and the Music app on this Mac.
import { config } from './config.ts';
import { startWatching } from './watch.ts';
import { startMacMusic } from './import/mac-music.ts';
import { lastfmEnabled, syncLastfm } from './import/lastfm.ts';
import { startBot } from './bot/bot.ts';
import { startAppServer } from './app/server.ts';
import { startTunnel } from './app/tunnel.ts';

console.log(`lifestats · данные: ${config.dataDir}`);
startWatching();
startMacMusic();

if (lastfmEnabled()) {
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    syncLastfm().then((r) => r.added && console.log(`[lastfm] +${r.added}`)).catch((e) => console.error('[lastfm]', e.message)).finally(() => { running = false; });
  };
  setTimeout(run, 5000);
  setInterval(run, config.lastfm.intervalMin * 60000);
}

const bot = startBot();

// Mini App: MINIAPP=0 turns it off; MINIAPP_URL=https://… uses your own address instead of a quick tunnel.
if (bot && process.env.MINIAPP !== '0') {
  const port = Number(process.env.MINIAPP_PORT || 8787);
  startAppServer(port, process.env.TELEGRAM_BOT_TOKEN!)
    .then(() => {
      if (process.env.MINIAPP_URL) bot.setAppUrl(process.env.MINIAPP_URL);
      else startTunnel(port, (url) => bot.setAppUrl(url));
    })
    .catch((e) => console.error('[app] Mini App не запустился:', e.message));
}
