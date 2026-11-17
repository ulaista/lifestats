// Music listening straight from the Music app on this Mac — no Last.fm, no third-party apps.
// With "Sync Library" on, the Mac's library carries play counts and last-played dates for
// plays on the iPhone too. We snapshot the library every few minutes and turn play-count
// increases into plays. Also reads "now playing".
//
// Limits: only tracks in the library count; play time is approximate (last-played date or
// poll time); history before the first snapshot is unknown (use the Apple privacy export for that).
import { execFile } from 'node:child_process';
import { db, kvGet, kvSet, tx } from '../db.ts';
import { notify } from '../events.ts';

db.exec(`CREATE TABLE IF NOT EXISTS mac_music_lib (
  pid TEXT PRIMARY KEY, artist TEXT, title TEXT, album TEXT, genre TEXT,
  duration_ms INTEGER, play_count INTEGER, played_at TEXT
) WITHOUT ROWID`);

// JXA: bulk property reads are fast even for big libraries. Never launches Music if it's closed
// (unless allowLaunch), so the poller doesn't pop the app open on its own.
const SCRIPT = (allowLaunch: boolean) => `
const M = Application('Music');
if (!M.running() && !${allowLaunch}) { JSON.stringify({ running: false }); } else {
  const t = M.libraryPlaylists[0].tracks;
  let now = null;
  try { if (M.playerState() === 'playing') { const c = M.currentTrack; now = { artist: c.artist(), title: c.name(), album: c.album() }; } } catch (e) {}
  JSON.stringify({ running: true, now,
    id: t.persistentID(), name: t.name(), artist: t.artist(), album: t.album(), genre: t.genre(),
    count: t.playedCount(), played: t.playedDate(), dur: t.duration() });
}`;

interface Snap {
  running: boolean; now?: { artist: string; title: string; album: string } | null;
  id: string[]; name: string[]; artist: string[]; album: string[]; genre: string[]; count: number[]; played: (string | null)[]; dur: number[];
}

function runJxa(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', '-e', src], { maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }, (err, out, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(out));
  });
}

const pad = (n: number) => String(n).padStart(2, '0');
/** ISO (UTC) → local wall-clock "YYYY-MM-DDTHH:MM:SS" in this Mac's timezone. */
function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export const macMusicState = { enabled: process.platform === 'darwin' && process.env.MAC_MUSIC !== '0', running: false, tracks: 0, lastPoll: null as string | null, error: null as string | null, baseline: kvGet('macmusic:baseline') ?? null };

/** MAC_MUSIC_LAUNCH=1: keep the Music app running hidden in the background, so plays from the iPhone sync in. */
function ensureMusicRunning(): Promise<void> {
  return new Promise((resolve) => execFile('pgrep', ['-x', 'Music'], (err) => {
    if (!err) return resolve();
    execFile('open', ['-g', '-j', '-a', 'Music'], () => setTimeout(resolve, 8000));
  }));
}

export async function pollMacMusic(): Promise<{ added: number }> {
  if (process.env.MAC_MUSIC_LAUNCH === '1') await ensureMusicRunning();
  const snap = JSON.parse(await runJxa(SCRIPT(false))) as Snap;
  macMusicState.lastPoll = new Date().toISOString();
  macMusicState.running = snap.running;
  macMusicState.error = null;
  if (!snap.running) return { added: 0 };

  // Now playing
  const np = snap.now ? JSON.stringify({ artist: snap.now.artist || '?', title: snap.now.title, album: snap.now.album || null, via: 'mac' }) : '';
  let changed = false;
  if (np !== (kvGet('music:nowplaying') ?? '')) { kvSet('music:nowplaying', np); changed = true; }

  const prev = new Map<string, { play_count: number; played_at: string | null }>();
  for (const r of db.prepare('SELECT pid, play_count, played_at FROM mac_music_lib').all() as { pid: string; play_count: number; played_at: string | null }[]) prev.set(r.pid, r);
  const firstRun = prev.size === 0;
  const upLib = db.prepare(`INSERT INTO mac_music_lib VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(pid) DO UPDATE SET
    artist = excluded.artist, title = excluded.title, album = excluded.album, genre = excluded.genre,
    duration_ms = excluded.duration_ms, play_count = excluded.play_count, played_at = excluded.played_at`);
  const addPlay = db.prepare(`INSERT INTO music_plays (source, date, played_at, hour, artist, title, album, genre, play_count, skip_count, duration_ms)
    VALUES ('mac',?,?,?,?,?,?,?,?,0,?) ON CONFLICT(source, played_at, artist, title) DO UPDATE SET
    play_count = play_count + excluded.play_count, duration_ms = COALESCE(duration_ms,0) + COALESCE(excluded.duration_ms,0)`);

  let added = 0;
  const nowLocal = localIso(new Date());
  tx(() => {
    for (let i = 0; i < snap.id.length; i++) {
      const pid = snap.id[i];
      const count = snap.count[i] || 0;
      const durMs = snap.dur[i] ? Math.round(snap.dur[i] * 1000) : null;
      const played = snap.played[i] ? localIso(new Date(snap.played[i]!)) : null;
      const p = prev.get(pid);
      if (!firstRun && count > (p?.play_count ?? 0)) {
        const d = count - (p?.play_count ?? 0);
        // Use the track's last-played time if it moved since the last snapshot, else "now".
        const at = played && played !== p?.played_at ? played : nowLocal;
        addPlay.run(at.slice(0, 10), at, +at.slice(11, 13), snap.artist[i] || 'Неизвестный исполнитель', snap.name[i] || '?', snap.album[i] || null, snap.genre[i] || null, d, durMs !== null ? durMs * d : null);
        added += d;
      }
      upLib.run(pid, snap.artist[i], snap.name[i], snap.album[i], snap.genre[i], durMs, count, played);
    }
  });
  macMusicState.tracks = snap.id.length;
  if (firstRun) { kvSet('macmusic:baseline', nowLocal); macMusicState.baseline = nowLocal; }
  if (seedLibraryHistory()) changed = true;
  kvSet('macmusic:last', new Date().toISOString());
  if (added || changed) notify('music');
  return { added };
}

/** Library history: every track's last-played date counts as one play (source 'maclib').
 *  Gives months of listening history right away; exact plays from polling win on the same day. */
export function seedLibraryHistory(): number {
  const r = db.prepare(`INSERT OR IGNORE INTO music_plays (source, date, played_at, hour, artist, title, album, genre, play_count, skip_count, duration_ms)
    SELECT 'maclib', substr(played_at, 1, 10), played_at, CAST(substr(played_at, 12, 2) AS INT), COALESCE(artist, 'Неизвестный исполнитель'), COALESCE(title, '?'), album, genre, 1, 0, duration_ms
    FROM mac_music_lib WHERE played_at IS NOT NULL`).run();
  return Number(r.changes);
}

export function startMacMusic(intervalMin = Number(process.env.MAC_MUSIC_MINUTES || 2)) {
  if (!macMusicState.enabled) return;
  const seeded = seedLibraryHistory();
  if (seeded) console.log(`[music] история из медиатеки: +${seeded}`);
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    pollMacMusic()
      .then((r) => r.added && console.log(`[music] +${r.added} прослушиваний`))
      .catch((e) => { macMusicState.error = e.message; console.error('[music]', e.message); })
      .finally(() => { running = false; });
  };
  setTimeout(run, 3000);
  setInterval(run, intervalMin * 60_000);
}
