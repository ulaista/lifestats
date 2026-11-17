// Automatic music sync via Last.fm (Apple Music has no public listening-history API,
// so the practical automatic path is: scrobble Apple Music → Last.fm → this dashboard).
import { db, kvGet, kvSet, tx } from '../db.ts';
import { config } from '../config.ts';
import { wallIso } from '../lib/time.ts';
import { notify } from '../events.ts';

const API = 'https://ws.audioscrobbler.com/2.0/';
const AVG_TRACK_MS = 210_000; // Last.fm doesn't return durations; estimate.

export function lastfmEnabled() {
  return Boolean(config.lastfm.apiKey && config.lastfm.user);
}

export async function syncLastfm(log: (s: string) => void = () => {}): Promise<{ added: number }> {
  if (!lastfmEnabled()) throw new Error('Last.fm не настроен (LASTFM_API_KEY, LASTFM_USER)');
  const since = Number(kvGet('lastfm:last_uts') || 0);
  const tzOffsetMin = Number(process.env.TZ_OFFSET_MIN ?? -new Date().getTimezoneOffset());
  let page = 1, pages = 1, added = 0, maxUts = since, changed = false;
  const st = db.prepare(`INSERT OR IGNORE INTO music_plays (source, date, played_at, hour, artist, title, album, genre, play_count, skip_count, duration_ms)
    VALUES ('lastfm',?,?,?,?,?,?,NULL,1,0,?)`);
  do {
    const url = new URL(API);
    url.search = new URLSearchParams({
      method: 'user.getrecenttracks', user: config.lastfm.user, api_key: config.lastfm.apiKey,
      format: 'json', limit: '200', page: String(page), from: String(since + 1),
    }).toString();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Last.fm HTTP ${res.status}`);
    const j: any = await res.json();
    if (j.error) throw new Error(`Last.fm: ${j.message}`);
    const rt = j.recenttracks;
    pages = Number(rt?.['@attr']?.totalPages || 1);
    const tracks: any[] = Array.isArray(rt?.track) ? rt.track : rt?.track ? [rt.track] : [];
    if (page === 1) {
      const np = tracks.find((t) => t['@attr']?.nowplaying);
      const val = np ? JSON.stringify({ artist: np.artist?.['#text'] || '?', title: np.name, album: np.album?.['#text'] || null }) : '';
      if (val !== (kvGet('lastfm:nowplaying') ?? '')) { kvSet('lastfm:nowplaying', val); changed = true; }
    }
    tx(() => {
      for (const t of tracks) {
        if (t['@attr']?.nowplaying) continue;
        const uts = Number(t.date?.uts);
        if (!uts) continue;
        const local = wallIso(uts * 1000 + tzOffsetMin * 60000);
        const r = st.run(local.slice(0, 10), local, +local.slice(11, 13), t.artist?.['#text'] || t.artist?.name || '?', t.name || '?', t.album?.['#text'] || null, AVG_TRACK_MS);
        added += Number(r.changes);
        if (uts > maxUts) maxUts = uts;
      }
    });
    log(`Last.fm: страница ${page}/${pages}`);
    page++;
    if (page <= pages) await new Promise((r) => setTimeout(r, 250)); // be polite to the API
  } while (page <= pages && page <= 500);
  if (maxUts > since) kvSet('lastfm:last_uts', String(maxUts));
  kvSet('lastfm:last_sync', new Date().toISOString());
  if (added || changed) notify('music');
  return { added };
}
