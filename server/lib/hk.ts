// Metadata about HealthKit types: how to aggregate, canonical unit, Russian label.

export type Kind = 'cum' | 'disc';

interface TypeInfo { label: string; unit: string; kind: Kind; group: string }

const Q = 'HKQuantityTypeIdentifier';

export const TYPES: Record<string, TypeInfo> = {
  [Q + 'StepCount']: { label: 'Шаги', unit: 'шаг', kind: 'cum', group: 'Активность' },
  [Q + 'DistanceWalkingRunning']: { label: 'Ходьба и бег', unit: 'км', kind: 'cum', group: 'Активность' },
  [Q + 'DistanceCycling']: { label: 'Велосипед', unit: 'км', kind: 'cum', group: 'Активность' },
  [Q + 'DistanceSwimming']: { label: 'Плавание', unit: 'км', kind: 'cum', group: 'Активность' },
  [Q + 'FlightsClimbed']: { label: 'Пролёты лестниц', unit: 'пролёт', kind: 'cum', group: 'Активность' },
  [Q + 'ActiveEnergyBurned']: { label: 'Активные калории', unit: 'ккал', kind: 'cum', group: 'Активность' },
  [Q + 'BasalEnergyBurned']: { label: 'Калории покоя', unit: 'ккал', kind: 'cum', group: 'Активность' },
  [Q + 'AppleExerciseTime']: { label: 'Минуты упражнений', unit: 'мин', kind: 'cum', group: 'Активность' },
  [Q + 'AppleStandTime']: { label: 'Время стоя', unit: 'мин', kind: 'cum', group: 'Активность' },
  [Q + 'AppleMoveTime']: { label: 'Минуты движения', unit: 'мин', kind: 'cum', group: 'Активность' },
  [Q + 'TimeInDaylight']: { label: 'Время на дневном свету', unit: 'мин', kind: 'cum', group: 'Активность' },
  [Q + 'PushCount']: { label: 'Толчки коляски', unit: 'раз', kind: 'cum', group: 'Активность' },
  [Q + 'SwimmingStrokeCount']: { label: 'Гребки', unit: 'раз', kind: 'cum', group: 'Активность' },
  [Q + 'NumberOfTimesFallen']: { label: 'Падения', unit: 'раз', kind: 'cum', group: 'Активность' },
  [Q + 'PhysicalEffort']: { label: 'Физическая нагрузка', unit: 'MET', kind: 'disc', group: 'Активность' },
  [Q + 'HeartRate']: { label: 'Пульс', unit: 'уд/мин', kind: 'disc', group: 'Сердце' },
  [Q + 'RestingHeartRate']: { label: 'Пульс в покое', unit: 'уд/мин', kind: 'disc', group: 'Сердце' },
  [Q + 'WalkingHeartRateAverage']: { label: 'Пульс при ходьбе', unit: 'уд/мин', kind: 'disc', group: 'Сердце' },
  [Q + 'HeartRateVariabilitySDNN']: { label: 'Вариабельность пульса (SDNN)', unit: 'мс', kind: 'disc', group: 'Сердце' },
  [Q + 'HeartRateRecoveryOneMinute']: { label: 'Восстановление пульса', unit: 'уд/мин', kind: 'disc', group: 'Сердце' },
  [Q + 'VO2Max']: { label: 'VO₂ max', unit: 'мл/кг·мин', kind: 'disc', group: 'Сердце' },
  [Q + 'OxygenSaturation']: { label: 'Кислород в крови', unit: '%', kind: 'disc', group: 'Дыхание' },
  [Q + 'RespiratoryRate']: { label: 'Частота дыхания', unit: 'вд/мин', kind: 'disc', group: 'Дыхание' },
  [Q + 'BloodPressureSystolic']: { label: 'Давление (сист.)', unit: 'мм рт. ст.', kind: 'disc', group: 'Сердце' },
  [Q + 'BloodPressureDiastolic']: { label: 'Давление (диаст.)', unit: 'мм рт. ст.', kind: 'disc', group: 'Сердце' },
  [Q + 'BodyMass']: { label: 'Вес', unit: 'кг', kind: 'disc', group: 'Тело' },
  [Q + 'BodyMassIndex']: { label: 'ИМТ', unit: '', kind: 'disc', group: 'Тело' },
  [Q + 'BodyFatPercentage']: { label: 'Процент жира', unit: '%', kind: 'disc', group: 'Тело' },
  [Q + 'LeanBodyMass']: { label: 'Сухая масса', unit: 'кг', kind: 'disc', group: 'Тело' },
  [Q + 'Height']: { label: 'Рост', unit: 'см', kind: 'disc', group: 'Тело' },
  [Q + 'AppleSleepingWristTemperature']: { label: 'Температура запястья во сне', unit: '°C', kind: 'disc', group: 'Тело' },
  [Q + 'BodyTemperature']: { label: 'Температура тела', unit: '°C', kind: 'disc', group: 'Тело' },
  [Q + 'WalkingSpeed']: { label: 'Скорость ходьбы', unit: 'км/ч', kind: 'disc', group: 'Мобильность' },
  [Q + 'WalkingStepLength']: { label: 'Длина шага', unit: 'см', kind: 'disc', group: 'Мобильность' },
  [Q + 'WalkingAsymmetryPercentage']: { label: 'Асимметрия ходьбы', unit: '%', kind: 'disc', group: 'Мобильность' },
  [Q + 'WalkingDoubleSupportPercentage']: { label: 'Двойная опора', unit: '%', kind: 'disc', group: 'Мобильность' },
  [Q + 'StairAscentSpeed']: { label: 'Скорость подъёма', unit: 'м/с', kind: 'disc', group: 'Мобильность' },
  [Q + 'StairDescentSpeed']: { label: 'Скорость спуска', unit: 'м/с', kind: 'disc', group: 'Мобильность' },
  [Q + 'SixMinuteWalkTestDistance']: { label: 'Тест 6-минутной ходьбы', unit: 'м', kind: 'disc', group: 'Мобильность' },
  [Q + 'AppleWalkingSteadiness']: { label: 'Устойчивость при ходьбе', unit: '%', kind: 'disc', group: 'Мобильность' },
  [Q + 'RunningSpeed']: { label: 'Скорость бега', unit: 'км/ч', kind: 'disc', group: 'Мобильность' },
  [Q + 'RunningPower']: { label: 'Мощность бега', unit: 'Вт', kind: 'disc', group: 'Мобильность' },
  [Q + 'RunningStrideLength']: { label: 'Длина шага при беге', unit: 'м', kind: 'disc', group: 'Мобильность' },
  [Q + 'RunningVerticalOscillation']: { label: 'Вертикальные колебания', unit: 'см', kind: 'disc', group: 'Мобильность' },
  [Q + 'RunningGroundContactTime']: { label: 'Контакт с землёй', unit: 'мс', kind: 'disc', group: 'Мобильность' },
  [Q + 'EnvironmentalAudioExposure']: { label: 'Шум вокруг', unit: 'дБ', kind: 'disc', group: 'Слух' },
  [Q + 'HeadphoneAudioExposure']: { label: 'Громкость наушников', unit: 'дБ', kind: 'disc', group: 'Слух' },
  [Q + 'EnvironmentalSoundReduction']: { label: 'Шумоподавление', unit: 'дБ', kind: 'disc', group: 'Слух' },
  [Q + 'DietaryWater']: { label: 'Вода', unit: 'мл', kind: 'cum', group: 'Питание' },
  [Q + 'DietaryEnergyConsumed']: { label: 'Калории (еда)', unit: 'ккал', kind: 'cum', group: 'Питание' },
  [Q + 'DietaryCaffeine']: { label: 'Кофеин', unit: 'мг', kind: 'cum', group: 'Питание' },
};

export function typeInfo(type: string): TypeInfo {
  const t = TYPES[type];
  if (t) return t;
  const short = shortName(type);
  if (/^Dietary/.test(short)) return { label: short.replace(/^Dietary/, 'Питание: '), unit: '', kind: 'cum', group: 'Питание' };
  return { label: short, unit: '', kind: 'disc', group: 'Прочее' };
}

export function shortName(type: string): string {
  return type.replace(/^HK(Quantity|Category|Correlation)TypeIdentifier/, '').replace(/^HKDataType/, '');
}

/**
 * Normalize a value to the canonical unit for its type.
 * Returns null when the unit is unknown for a type whose canonical unit we care about.
 */
export function normalize(type: string, value: number, unit: string): number {
  const u = (unit || '').trim();
  switch (u) {
    case 'mi': return value * 1.609344;
    case 'm':
      if (type.includes('Distance') && !type.includes('SixMinute')) return value / 1000;
      if (type.endsWith('Height') || type.includes('WalkingStepLength')) return value * 100;
      return value;
    case 'ft': return type.includes('Distance') ? value * 0.0003048 : value * 30.48; // height in cm
    case 'yd': return value * 0.0009144;
    case 'kJ': return value / 4.184;
    case 'Cal': return value; // big calorie == kcal
    case 'lb': return value * 0.45359237;
    case 'g': return type.includes('BodyMass') || type.includes('LeanBody') ? value / 1000 : value;
    case 'degF': return (value - 32) * 5 / 9;
    case 'in': return value * 2.54;
    case 'm/s': return type.includes('Walking') || type.includes('RunningSpeed') ? value * 3.6 : value;
    case 'mi/hr': return value * 1.609344;
    case 'km/hr': return value;
    case 's': return type.includes('Time') && !type.includes('GroundContact') ? value / 60 : value * 1000;
    case 'hr': return value * 60;
    case '%': return value <= 1.0001 ? value * 100 : value;
    case 'fl_oz_us': return value * 29.5735;
    case 'L': return value * 1000;
    default: return value;
  }
}
