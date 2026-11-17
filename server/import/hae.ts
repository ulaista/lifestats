// Ingest for the iOS app "Health Auto Export" (REST API automation, JSON v2).
// Recommended app settings: Format JSON, Aggregate data ON, Time grouping "Hours",
// Sleep: not aggregated (so we get stages), Include workouts ON.
import { parseHkDate, addDays } from '../lib/time.ts';
import { normalize, typeInfo } from '../lib/hk.ts';
import { kvSet, tx } from '../db.ts';
import { rebuildDaily, rebuildSleep } from '../derive.ts';
import { SLEEP_STAGE, activityName, writeHourly, writeSleep, writeWorkouts, type SleepSeg, type Workout } from './store.ts';

const Q = 'HKQuantityTypeIdentifier';
// HAE metric name → HealthKit identifier
const MAP: Record<string, string> = {
  step_count: 'StepCount', walking_running_distance: 'DistanceWalkingRunning', cycling_distance: 'DistanceCycling',
  swimming_distance: 'DistanceSwimming', flights_climbed: 'FlightsClimbed', active_energy: 'ActiveEnergyBurned',
  basal_energy_burned: 'BasalEnergyBurned', resting_energy: 'BasalEnergyBurned', apple_exercise_time: 'AppleExerciseTime',
  apple_stand_time: 'AppleStandTime', apple_move_time: 'AppleMoveTime', time_in_daylight: 'TimeInDaylight',
  heart_rate: 'HeartRate', resting_heart_rate: 'RestingHeartRate', walking_heart_rate_average: 'WalkingHeartRateAverage',
  heart_rate_variability: 'HeartRateVariabilitySDNN', heart_rate_variability_sdnn: 'HeartRateVariabilitySDNN',
  vo2_max: 'VO2Max', blood_oxygen_saturation: 'OxygenSaturation', respiratory_rate: 'RespiratoryRate',
  weight_body_mass: 'BodyMass', body_mass_index: 'BodyMassIndex', body_fat_percentage: 'BodyFatPercentage',
  lean_body_mass: 'LeanBodyMass', height: 'Height', apple_sleeping_wrist_temperature: 'AppleSleepingWristTemperature',
  body_temperature: 'BodyTemperature', walking_speed: 'WalkingSpeed', walking_step_length: 'WalkingStepLength',
  walking_asymmetry_percentage: 'WalkingAsymmetryPercentage', walking_double_support_percentage: 'WalkingDoubleSupportPercentage',
  stair_speed_up: 'StairAscentSpeed', stair_speed_down: 'StairDescentSpeed', six_minute_walking_test_distance: 'SixMinuteWalkTestDistance',
  environmental_audio_exposure: 'EnvironmentalAudioExposure', headphone_audio_exposure: 'HeadphoneAudioExposure',
  physical_effort: 'PhysicalEffort', running_speed: 'RunningSpeed', running_power: 'RunningPower',
  dietary_water: 'DietaryWater', dietary_energy: 'DietaryEnergyConsumed', dietary_caffeine: 'DietaryCaffeine',
  blood_pressure_systolic: 'BloodPressureSystolic', blood_pressure_diastolic: 'BloodPressureDiastolic',
};
const HAE_UNITS: Record<string, string> = { 'count/min': 'count/min', kcal: 'kcal', kJ: 'kJ', km: 'km', mi: 'mi', m: 'm', min: 'min', hr: 'hr', '%': '%', kg: 'kg', lb: 'lb', ms: 'ms' };

const num = (x: unknown): number | null => {
  if (x && typeof x === 'object' && 'qty' in (x as object)) return num((x as { qty: unknown }).qty);
  const n = typeof x === 'number' ? x : parseFloat(String(x));
  return Number.isFinite(n) ? n : null;
};

export function ingestHealthAutoExport(body: any): Record<string, number> {
  const data = body?.data ?? body;
  const metrics: any[] = data?.metrics ?? [];
  const stats = { metrics: 0, points: 0, sleep: 0, workouts: 0 };
  const hourly: Parameters<typeof writeHourly>[0] = [];
  const sleep: SleepSeg[] = [];
  const workouts: Workout[] = [];
  let minDate = '9999', maxDate = '0000';
  const touch = (d: string) => { if (d < minDate) minDate = d; if (d > maxDate) maxDate = d; };

  for (const m of metrics) {
    stats.metrics++;
    const name = String(m.name || '');
    if (name === 'sleep_analysis') {
      for (const p of m.data ?? []) {
        if (p.startDate && p.endDate && p.value) {
          // Unaggregated: one row per stage segment
          const s = parseHkDate(p.startDate), e = parseHkDate(p.endDate);
          const stage = SLEEP_STAGE[p.value];
          if (s && e && stage) { sleep.push({ source: p.source || 'HAE', startLocal: s.local, endLocal: e.local, startMs: s.epoch, endMs: e.epoch, stage }); stats.sleep++; }
        } else if (p.sleepStart && p.sleepEnd) {
          // Aggregated night: we only know totals → synthesize one segment per stage, back-to-back
          const s = parseHkDate(p.sleepStart), e = parseHkDate(p.sleepEnd);
          if (!s || !e) continue;
          let t = s.epoch, tl = s.local;
          const parts: [string, number][] = [['deep', num(p.deep) ?? 0], ['core', num(p.core) ?? 0], ['rem', num(p.rem) ?? 0], ['awake', num(p.awake) ?? 0]];
          const staged = parts.reduce((a, b) => a + b[1], 0);
          if (!staged) parts.push(['asleep', num(p.asleep) ?? num(p.totalSleep) ?? 0]);
          for (const [stage, hrs] of parts) {
            if (!hrs) continue;
            const ms = hrs * 3600000;
            const endLocal = new Date(Date.parse(tl + 'Z') + ms).toISOString().slice(0, 19);
            sleep.push({ source: p.source || 'HAE', startLocal: tl, endLocal, startMs: t, endMs: t + ms, stage });
            t += ms; tl = endLocal;
          }
          if (p.inBedStart && p.inBedEnd) {
            const a = parseHkDate(p.inBedStart), b = parseHkDate(p.inBedEnd);
            if (a && b) sleep.push({ source: 'HAE inbed', startLocal: a.local, endLocal: b.local, startMs: a.epoch, endMs: b.epoch, stage: 'inbed' });
          }
          stats.sleep++;
        }
      }
      continue;
    }
    const type = MAP[name] ? Q + MAP[name] : 'hae:' + name;
    const info = typeInfo(type);
    const unit = HAE_UNITS[m.units] ?? m.units ?? '';
    for (const p of m.data ?? []) {
      const d = parseHkDate(p.date);
      if (!d) continue;
      const hour = d.local.slice(0, 13);
      touch(hour.slice(0, 10));
      let avg = num(p.Avg ?? p.avg ?? p.qty), mn = num(p.Min ?? p.min), mx = num(p.Max ?? p.max);
      if (name === 'blood_pressure') {
        for (const [k, t] of [['systolic', 'BloodPressureSystolic'], ['diastolic', 'BloodPressureDiastolic']] as const) {
          const v = num(p[k]);
          if (v !== null) hourly.push({ type: Q + t, hour, source: 'HAE', kind: 'disc', sum: v, min: v, max: v, count: 1 });
        }
        continue;
      }
      if (avg === null) continue;
      avg = normalize(type, avg, unit);
      mn = mn === null ? avg : normalize(type, mn, unit);
      mx = mx === null ? avg : normalize(type, mx, unit);
      // HAE aggregates are already de-duplicated across devices → single "HAE" source.
      hourly.push({ type, hour, source: 'HAE', kind: info.kind, sum: avg, min: mn, max: mx, count: 1 });
      stats.points++;
    }
  }

  for (const w of data?.workouts ?? []) {
    const s = parseHkDate(w.start), e = parseHkDate(w.end);
    if (!s || !e) continue;
    const dist = w.distance ? normalize('Distance', num(w.distance) ?? 0, w.distance.units) : null;
    const kcal = w.activeEnergyBurned ? normalize('Energy', num(w.activeEnergyBurned) ?? 0, w.activeEnergyBurned.units) : (w.activeEnergy ? num(w.activeEnergy) : null);
    const hrAvg = num(w.heartRate?.avg ?? w.avgHeartRate);
    const hrMax = num(w.heartRate?.max ?? w.maxHeartRate);
    const dur = num(w.duration);
    workouts.push({
      source: 'HAE', activity: activityName(String(w.name || 'Other')),
      startLocal: s.local, endLocal: e.local, startMs: s.epoch,
      durationMin: dur !== null ? dur / 60 : (e.epoch - s.epoch) / 60000,
      distanceKm: dist || null, energyKcal: kcal || null, hrAvg, hrMax,
    });
    touch(s.local.slice(0, 10));
    stats.workouts++;
  }

  tx(() => { writeHourly(hourly); writeSleep(sleep); writeWorkouts(workouts); });
  kvSet('hae:last', new Date().toISOString());
  if (hourly.length) rebuildDaily(minDate, maxDate);
  if (sleep.length) {
    const from = sleep.reduce((a, s) => (s.startLocal < a ? s.startLocal : a), '9999').slice(0, 10);
    rebuildSleep(addDays(from, -1));
  }
  return stats;
}
