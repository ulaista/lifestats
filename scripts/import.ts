// CLI import: node scripts/import.ts <export.zip | export.xml | apple-music.zip | *.csv | *.json>
import path from 'node:path';
import { importAny } from '../server/import/index.ts';

const files = process.argv.slice(2);
if (!files.length) {
  console.log('Использование: npm run import -- <export.zip | Apple Media Services.zip | *.csv>');
  process.exit(1);
}
for (const f of files) {
  const t0 = Date.now();
  console.log(`→ ${path.basename(f)}`);
  const res = await importAny(path.resolve(f), (p) => {
    const pct = p.total ? ((p.bytes / p.total) * 100).toFixed(0) + '%' : '';
    process.stdout.write(`\r  ${p.phase} ${pct} · ${p.records.toLocaleString('ru')} записей   `);
  });
  console.log(`\n  готово за ${((Date.now() - t0) / 1000).toFixed(1)} с:`, res);
}
