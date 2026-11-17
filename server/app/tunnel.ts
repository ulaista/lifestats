// Public HTTPS address for the Mini App, no account needed:
//   TUNNEL=serveo (default) — SSH reverse tunnel with a fixed name (https://<SERVEO_NAME>.serveousercontent.com);
//   TUNNEL=localhost.run — SSH reverse tunnel, random address that rotates every few minutes (fallback);
//   TUNNEL=cloudflare — Cloudflare quick tunnel (needs outbound port 7844).
// The tunnel only forwards to 127.0.0.1; every API call still has to carry a valid Telegram signature.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

function binary(): string {
  if (process.env.CLOUDFLARED) return process.env.CLOUDFLARED;
  for (const p of ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared']) if (fs.existsSync(p)) return p;
  return 'cloudflared';
}

export const tunnelState = { url: null as string | null, running: false, error: null as string | null };

/** Keeps a quick tunnel to `port` alive and reports each new public URL. */
export function startTunnel(port: number, onUrl: (url: string) => void) {
  let child: ChildProcess | null = null;
  let backoff = 5000;
  let stopping = false;
  let failures = 0;
  const run = () => {
    tunnelState.running = true;
    // Serveo keeps the address fixed; after repeated failures fall back to localhost.run for one round.
    let provider = process.env.TUNNEL || 'serveo';
    if (provider === 'serveo' && failures >= 3 && failures % 3 === 0) provider = 'localhost.run';
    const ssh = ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=20'];
    child = provider === 'cloudflare'
      ? spawn(binary(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
      : provider === 'serveo'
        ? spawn('ssh', [...ssh, '-R', `${process.env.SERVEO_NAME || 'lifestats-ul'}:80:127.0.0.1:${port}`, 'serveo.net'], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('ssh', [...ssh, '-R', `80:127.0.0.1:${port}`, 'nokey@localhost.run'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const re = provider === 'cloudflare' ? /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
      : provider === 'serveo' ? /https:\/\/[a-z0-9-]+\.serveo(?:usercontent\.com|\.net)/
        : /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.lhr\.life/;
    const startedAt = Date.now();
    const scan = (buf: Buffer) => {
      const m = re.exec(buf.toString());
      if (m && m[0] !== tunnelState.url) {
        tunnelState.url = m[0];
        tunnelState.error = null;
        backoff = 5000;
        console.log(`[app] Mini App доступен через туннель: ${m[0]}`);
        onUrl(m[0]);
      }
    };
    child.stdout!.on('data', scan);
    child.stderr!.on('data', scan);
    child.on('error', (e) => { tunnelState.error = e.message; console.error('[app] туннель не запустился:', e.message); });
    child.on('exit', (code) => {
      tunnelState.running = false;
      tunnelState.url = null;
      if (stopping) return;
      failures = Date.now() - startedAt > 10 * 60_000 ? 0 : failures + 1; // a long-lived session isn't a failure
      console.warn(`[app] туннель упал (код ${code}), перезапуск через ${backoff / 1000} с`);
      setTimeout(run, backoff);
      backoff = Math.min(backoff * 2, 5 * 60_000);
    });
  };
  run();
  const stop = () => { stopping = true; child?.kill(); };
  process.on('exit', stop);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { stop(); process.exit(0); });
}
