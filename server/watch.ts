// Local auto-sync without exposing the server to the internet:
//  • Health Auto Export → automation "iCloud Drive" (JSON) → files appear on this Mac → imported here.
//  • data/inbox: drop any supported file (export.zip, Apple Music zip/CSV, screen time CSV) and it is imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.ts';
import { kvGet, kvSet } from './db.ts';
import { importAny } from './import/index.ts';
import { notify } from './events.ts';

const SUPPORTED = /\.(json|zip|xml|csv)$/i;

/** Health Auto Export's iCloud Drive folder: env override, else look for its container in ~/Library/Mobile Documents. */
// Async on purpose: touching iCloud folders can trigger a macOS permission prompt,
// and a sync call would freeze the whole server until the prompt is answered.
export async function findHaeDir(): Promise<string | null> {
  if (process.env.HAE_WATCH_DIR) return path.resolve(process.env.HAE_WATCH_DIR.replace(/^~/, os.homedir()));
  const base = path.join(os.homedir(), 'Library', 'Mobile Documents');
  try {
    for (const d of await fs.promises.readdir(base)) {
      if (/health.?(auto)?.?export/i.test(d)) return path.join(base, d, 'Documents');
    }
  } catch { /* no access or no iCloud */ }
  return null;
}

function listFiles(dir: string, depth = 0): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // includes iCloud placeholders ".name.icloud"
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < 3 && e.name !== 'done') out = out.concat(listFiles(p, depth + 1));
    else if (e.isFile() && SUPPORTED.test(e.name)) out.push(p);
  }
  return out;
}

export const watchState = { haeDir: null as string | null, inbox: '', lastScan: null as string | null, lastFile: null as string | null, error: null as string | null };

let busy = false;
async function scan() {
  if (busy) return;
  busy = true;
  try {
    watchState.haeDir = await findHaeDir();
    watchState.lastScan = new Date().toISOString();
    let changed = false;
    // 1) iCloud folder: never modify the user's files, remember what was imported (name + mtime + size).
    if (watchState.haeDir) {
      const files = listFiles(watchState.haeDir).filter((f) => /\.json$/i.test(f)).sort();
      for (const f of files) {
        const st = fs.statSync(f);
        if (Date.now() - st.mtimeMs < 5000) continue; // still being written / synced
        const sig = `${st.mtimeMs}:${st.size}`;
        const key = 'watch:' + path.relative(watchState.haeDir, f);
        if (kvGet(key) === sig) continue;
        try {
          // Keep a local copy: handy for re-imports and readable without iCloud permissions.
          const copy = path.join(config.dataDir, 'icloud', path.relative(watchState.haeDir, f));
          fs.mkdirSync(path.dirname(copy), { recursive: true });
          fs.copyFileSync(f, copy);
          await importAny(copy);
          kvSet(key, sig);
          kvSet('hae:last', new Date().toISOString());
          watchState.lastFile = path.basename(f);
          changed = true;
          console.log('[watch] импортирован', path.basename(f));
        } catch (e) { watchState.error = `${path.basename(f)}: ${(e as Error).message}`; console.error('[watch]', watchState.error); kvSet(key, sig); }
      }
    }
    // 2) Inbox: import and move to inbox/done.
    for (const f of listFiles(watchState.inbox)) {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs < 5000) continue;
      const done = path.join(watchState.inbox, 'done');
      fs.mkdirSync(done, { recursive: true });
      try {
        await importAny(f);
        watchState.lastFile = path.basename(f);
        changed = true;
        console.log('[inbox] импортирован', path.basename(f));
      } catch (e) { watchState.error = `${path.basename(f)}: ${(e as Error).message}`; console.error('[inbox]', watchState.error); }
      fs.renameSync(f, path.join(done, `${Date.now()}-${path.basename(f)}`));
    }
    if (changed) notify('watch');
  } finally {
    busy = false;
  }
}

export function startWatching(intervalMs = 60_000) {
  watchState.inbox = path.join(config.dataDir, 'inbox');
  fs.mkdirSync(watchState.inbox, { recursive: true });
  const run = () => scan().catch((e) => { watchState.error = String(e?.message || e); });
  setTimeout(run, 2000);
  setInterval(run, intervalMs);
  // React faster than the poll when something lands in the inbox / iCloud folder.
  let t: ReturnType<typeof setTimeout> | undefined;
  const kick = () => { clearTimeout(t); t = setTimeout(run, 6000); };
  try { fs.watch(watchState.inbox, kick); } catch { /* polling still works */ }
  findHaeDir().then((dir) => { if (dir) try { fs.watch(dir, { recursive: true }, kick); } catch { /* polling */ } });
}
