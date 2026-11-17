// Generates a synthetic Apple Health export.zip (+ Apple Music CSV) for testing.
// Usage: node scripts/gen-sample.ts [days=400]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const days = Number(process.argv[2] || 400);
const out = path.resolve(import.meta.dirname, '..', 'data', 'sample');
const dir = path.join(out, 'apple_health_export');
fs.mkdirSync(dir, { recursive: true });

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rnd(); return s - 3; };
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0500`; };

const W = 'Apple Watch (Sample)', P = 'iPhone (Sample)';
const lines: string[] = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE HealthData [\n<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord)*)>\n]>',
  '<HealthData locale="ru_RU">',
  ' <ExportDate value="2026-11-15 10:00:00 +0500"/>',
];
const rec = (type: string, src: string, unit: string, s: number, e: number, v: number | string, extra = '') =>
  lines.push(` <Record type="${type}" sourceName="${src}" sourceVersion="1" unit="${unit}" creationDate="${fmt(e)}" startDate="${fmt(s)}" endDate="${fmt(e)}" value="${v}"${extra ? '>' : '/>'}`) && extra && lines.push(extra, ' </Record>');

const Q = 'HKQuantityTypeIdentifier';
const end = Date.UTC(2026, 10, 15);
const H = 3600000, M = 60000;
const acts = ['Running', 'Walking', 'TraditionalStrengthTraining', 'Cycling', 'Yoga'];
const music: string[] = ['Country,Track Identifier,Media type,Date Played,Hours,Play Duration Milliseconds,Source Type,Play Count,Skip Count,Ignore For Recommendations,Track Reference,Track Description'];
const artists = [['Radiohead', ['Weird Fishes', 'Reckoner', 'Nude', 'Daydreaming']], ['Земфира', ['Хочешь?', 'Небо Лондона', 'Искала']], ['Bonobo', ['Kerala', 'Cirrus', 'Kong']], ['Daft Punk', ['Instant Crush', 'Digital Love']], ['Кино', ['Группа крови', 'Кукушка', 'Звезда по имени Солнце']], ['Nils Frahm', ['Says', 'All Melody']], ['Tame Impala', ['Let It Happen', 'The Less I Know the Better']]] as const;

for (let d = days; d >= 1; d--) {
  const day = end - d * 86400000;
  const weekend = [0, 6].includes(new Date(day).getUTCDay());
  const fit = 1 + 0.25 * Math.sin(d / 40);
  // Steps: hourly chunks from Watch, partial duplicates from iPhone
  for (let h = 7; h < 23; h++) {
    const base = (h === 8 || h === 18 ? 1400 : h > 12 && h < 14 ? 900 : 380) * fit * (weekend ? 1.2 : 1);
    const v = Math.max(0, Math.round(base * (1 + 0.5 * gauss())));
    const s = day + h * H + 5 * M;
    rec(Q + 'StepCount', W, 'count', s, s + 40 * M, v);
    if (rnd() < 0.6) rec(Q + 'StepCount', P, 'count', s, s + 40 * M, Math.round(v * 0.8));
    rec(Q + 'DistanceWalkingRunning', W, 'km', s, s + 40 * M, (v * 0.00075).toFixed(3));
    rec(Q + 'ActiveEnergyBurned', W, 'kcal', s, s + 40 * M, (v * 0.045 + 3).toFixed(2));
    rec(Q + 'BasalEnergyBurned', W, 'kcal', s, s + 59 * M, (70 + gauss()).toFixed(2));
    if (rnd() < 0.15) rec(Q + 'FlightsClimbed', P, 'count', s, s + 10 * M, 1 + Math.floor(rnd() * 4));
    if (h % 2 === 0) rec(Q + 'AppleExerciseTime', W, 'min', s, s + 30 * M, Math.round(rnd() * 8));
  }
  // Heart rate every ~10 min while awake, sparser at night
  const rhr = 58 + 3 * Math.cos(d / 30) + gauss() * 1.5;
  for (let m = 0; m < 1440; m += 10 + Math.floor(rnd() * 6)) {
    const h = m / 60;
    const asleep = h < 7;
    const v = Math.round((asleep ? rhr - 4 : rhr + 18 + (h === 8 || h === 18 ? 25 : 0)) + gauss() * 6);
    rec(Q + 'HeartRate', W, 'count/min', day + m * M, day + m * M, v);
  }
  rec(Q + 'RestingHeartRate', W, 'count/min', day + 6 * H, day + 22 * H, Math.round(rhr));
  rec(Q + 'WalkingHeartRateAverage', W, 'count/min', day + 7 * H, day + 22 * H, Math.round(rhr + 35 + gauss() * 3));
  for (let i = 0; i < 4; i++) rec(Q + 'HeartRateVariabilitySDNN', W, 'ms', day + (1 + i * 5) * H, day + (1 + i * 5) * H + M, (45 + gauss() * 12 + 5 * Math.sin(d / 25)).toFixed(1));
  rec(Q + 'RespiratoryRate', W, 'count/min', day + 3 * H, day + 3 * H, (14.5 + gauss() * 0.8).toFixed(1));
  rec(Q + 'OxygenSaturation', W, '%', day + 4 * H, day + 4 * H, (0.96 + rnd() * 0.03).toFixed(2));
  if (d % 3 === 0) rec(Q + 'BodyMass', 'Весы', 'kg', day + 7 * H, day + 7 * H, (78 - (days - d) * 0.008 + gauss() * 0.3).toFixed(1));
  if (d % 7 === 0) rec(Q + 'VO2Max', W, 'mL/min·kg', day + 18 * H, day + 18 * H, (44 + (days - d) * 0.005 + gauss() * 0.5).toFixed(2));
  rec(Q + 'TimeInDaylight', W, 'min', day + 12 * H, day + 13 * H, Math.round(20 + rnd() * 60));
  rec(Q + 'EnvironmentalAudioExposure', W, 'dBASPL', day + 14 * H, day + 14 * H + 30 * M, (62 + gauss() * 5).toFixed(1));
  // Sleep: night before this day; bedtime ~23:30 ± 50min
  const bed = day - 30 * M + gauss() * 50 * M + (weekend ? 45 * M : 0);
  const sleepLen = (7.1 + gauss() * 0.7 + (weekend ? 0.6 : 0)) * H;
  rec('HKCategoryTypeIdentifierSleepAnalysis', P, '', bed - 15 * M, bed + sleepLen + 10 * M, 'HKCategoryValueSleepAnalysisInBed');
  let t = bed;
  while (t < bed + sleepLen) {
    const r = rnd();
    const stage = r < 0.52 ? 'AsleepCore' : r < 0.67 ? 'AsleepDeep' : r < 0.92 ? 'AsleepREM' : 'Awake';
    const len = Math.min((stage === 'Awake' ? 3 + rnd() * 8 : 15 + rnd() * 40) * M, bed + sleepLen - t);
    rec('HKCategoryTypeIdentifierSleepAnalysis', W, '', t, t + len, 'HKCategoryValueSleepAnalysis' + stage);
    t += len;
  }
  if (rnd() < 0.2) rec('HKCategoryTypeIdentifierMindfulSession', W, '', day + 21 * H, day + 21 * H + 10 * M, 'HKCategoryValueNotApplicable');
  // Workouts
  if (rnd() < (weekend ? 0.7 : 0.4)) {
    const a = acts[Math.floor(rnd() * acts.length)];
    const s = day + (weekend ? 10 : 19) * H, dur = 25 + rnd() * 50;
    const km = a === 'Running' ? dur / 6 : a === 'Cycling' ? dur / 2.5 : a === 'Walking' ? dur / 11 : 0;
    lines.push(` <Workout workoutActivityType="HKWorkoutActivityType${a}" duration="${dur.toFixed(2)}" durationUnit="min" sourceName="${W}" sourceVersion="1" creationDate="${fmt(s + dur * M)}" startDate="${fmt(s)}" endDate="${fmt(s + dur * M)}">`);
    lines.push(`  <WorkoutStatistics type="${Q}ActiveEnergyBurned" startDate="${fmt(s)}" endDate="${fmt(s + dur * M)}" sum="${(dur * 9).toFixed(1)}" unit="kcal"/>`);
    if (km) lines.push(`  <WorkoutStatistics type="${Q}DistanceWalkingRunning" startDate="${fmt(s)}" endDate="${fmt(s + dur * M)}" sum="${km.toFixed(2)}" unit="km"/>`);
    lines.push(`  <WorkoutStatistics type="${Q}HeartRate" startDate="${fmt(s)}" endDate="${fmt(s + dur * M)}" average="${Math.round(125 + rnd() * 30)}" minimum="90" maximum="${Math.round(160 + rnd() * 25)}" unit="count/min"/>`);
    lines.push(' </Workout>');
  }
  const ds = new Date(day).toISOString().slice(0, 10);
  lines.push(` <ActivitySummary dateComponents="${ds}" activeEnergyBurned="${(450 * fit + gauss() * 80).toFixed(1)}" activeEnergyBurnedGoal="500" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="${Math.round(30 * fit + gauss() * 10)}" appleExerciseTimeGoal="30" appleStandHours="${Math.round(10 + gauss() * 2)}" appleStandHoursGoal="12"/>`);
  // Music (Apple Music "Play History Daily Tracks" format)
  const n = Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    const [ar, songs] = artists[Math.min(artists.length - 1, Math.floor(Math.abs(gauss()) * 3))];
    const song = songs[Math.floor(rnd() * songs.length)];
    const plays = 1 + Math.floor(rnd() * 3);
    music.push(`UZ,${1000 + ar.length * 31 + song.length},AUDIO,${ds.replaceAll('-', '')},"${8 + Math.floor(rnd() * 14)}",${plays * 200000 + Math.floor(rnd() * 60000)},IPHONE,${plays},${rnd() < 0.2 ? 1 : 0},false,${ar.length},"${ar} - ${song}"`);
  }
}
lines.push('</HealthData>');
fs.writeFileSync(path.join(dir, 'export.xml'), lines.join('\n'));
fs.rmSync(path.join(out, 'export.zip'), { force: true });
execFileSync('zip', ['-qr', 'export.zip', 'apple_health_export'], { cwd: out });
fs.writeFileSync(path.join(out, 'Apple Music - Play History Daily Tracks.csv'), music.join('\n'));
console.log(`Готово: ${path.join(out, 'export.zip')} (${(fs.statSync(path.join(out, 'export.zip')).size / 1e6).toFixed(1)} MB), ${lines.length} строк`);
