// Diagnostics: can this process read the HealthExport iCloud folder?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const out = [];
const base = path.join(os.homedir(), 'Library', 'Mobile Documents');
for (const p of [base, path.join(base, 'iCloud~HealthExport'), path.join(base, 'iCloud~HealthExport', 'Documents'), path.join(base, 'iCloud~HealthExport', 'Documents', 'Health')]) {
  try { out.push(`${p}: ${fs.readdirSync(p).filter((n) => /health|json|Documents/i.test(n)).slice(0, 10).join(', ')}`); }
  catch (e) { out.push(`${p}: ${e.code}`); }
}
fs.writeFileSync(path.join(import.meta.dirname, '..', 'data', 'icloud-check.txt'), out.join('\n') + '\n');
