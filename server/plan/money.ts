// Expenses: "кофе 350", "такси 600 вчера" → amount, currency, category, date. Stays in the owner's database.
import { db } from '../db.ts';
import { nowLocal, todayLocal, normTime, dayLabel } from './store.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS expenses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  amount     REAL NOT NULL,
  currency   TEXT NOT NULL DEFAULT 'RUB',
  category   TEXT NOT NULL,
  note       TEXT,
  date       TEXT NOT NULL,             -- local 'YYYY-MM-DD'
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses(date);
`);

export const CATEGORIES: [string, string][] = [
  ['Продукты', '🛒'], ['Кафе и рестораны', '☕'], ['Доставка еды', '🥡'], ['Транспорт', '🚇'], ['Такси', '🚕'],
  ['Жильё', '🏠'], ['Связь и интернет', '📶'], ['Подписки', '🔁'], ['Учёба', '🎓'], ['Здоровье', '💊'], ['Спорт', '🏋️'],
  ['Одежда', '👕'], ['Красота и уход', '🧴'], ['Развлечения', '🎬'], ['Подарки', '🎁'], ['Техника', '💻'], ['Путешествия', '✈️'],
  ['Переводы', '💸'], ['Другое', '📦'],
];
const ICON = new Map(CATEGORIES);
export const catIcon = (c: string) => ICON.get(c) ?? '📦';
export const CURRENCIES: Record<string, string> = { RUB: '₽', UZS: 'сум', USD: '$', EUR: '€', KZT: '₸' };

export interface Expense { id: number; amount: number; currency: string; category: string; note: string | null; date: string; created_at: string }

const fmtNum = (n: number) => (Math.round(n * 100) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
export const money = (n: number, cur = 'RUB') => (cur === 'USD' || cur === 'EUR' ? `${CURRENCIES[cur]}${fmtNum(n)}` : `${fmtNum(n)} ${CURRENCIES[cur] ?? cur}`);

function clean(f: Partial<Expense>): Partial<Expense> {
  const out: Partial<Expense> = { ...f };
  if ('amount' in f) { const a = Number(String(f.amount).replace(/\s/g, '').replace(',', '.')); if (!Number.isFinite(a) || a <= 0) throw new Error('Сумма должна быть больше нуля'); out.amount = a; }
  if ('currency' in f) { const c = String(f.currency || 'RUB').toUpperCase().replace('РУБ', 'RUB').replace('СУМ', 'UZS'); if (!CURRENCIES[c]) throw new Error(`Валюта: ${Object.keys(CURRENCIES).join(', ')}`); out.currency = c; }
  if ('category' in f) out.category = ICON.has(String(f.category)) ? String(f.category) : 'Другое';
  if ('date' in f) out.date = (normTime(f.date) ?? todayLocal()).slice(0, 10);
  return out;
}

export const getExpense = (id: number) => (db.prepare('SELECT * FROM expenses WHERE id = ?').get(id) as Expense | undefined) ?? null;

export function addExpense(f: { amount: unknown; currency?: string; category: string; note?: string | null; date?: string | null }): Expense {
  const c = clean({ amount: f.amount as number, currency: f.currency ?? 'RUB', category: f.category, date: f.date ?? todayLocal() });
  const r = db.prepare('INSERT INTO expenses(amount, currency, category, note, date, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(c.amount!, c.currency!, c.category!, f.note?.trim() || null, c.date!, nowLocal());
  return getExpense(Number(r.lastInsertRowid))!;
}

export function updateExpense(id: number, f: Partial<Expense>): Expense {
  const old = getExpense(id);
  if (!old) throw new Error(`Нет траты $${id}`);
  const it = { ...old, ...clean(f) };
  db.prepare('UPDATE expenses SET amount=?, currency=?, category=?, note=?, date=? WHERE id=?').run(it.amount, it.currency, it.category, it.note, it.date, id);
  return getExpense(id)!;
}

export function deleteExpense(id: number): Expense {
  const it = getExpense(id);
  if (!it) throw new Error(`Нет траты $${id}`);
  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  return it;
}

export function findExpenses(f: { from?: string; to?: string; category?: string; query?: string } = {}, limit = 50): Expense[] {
  const where: string[] = [], args: unknown[] = [];
  if (f.from) { where.push('date >= ?'); args.push(normTime(f.from)!.slice(0, 10)); }
  if (f.to) { where.push('date <= ?'); args.push(normTime(f.to)!.slice(0, 10)); }
  if (f.category) { where.push('category = ?'); args.push(f.category); }
  const rows = db.prepare(`SELECT * FROM expenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY date DESC, id DESC LIMIT ${f.query ? 2000 : limit}`).all(...args) as Expense[];
  if (!f.query) return rows;
  const w = f.query.toLowerCase();
  return rows.filter((e) => `${e.note ?? ''} ${e.category}`.toLowerCase().includes(w)).slice(0, limit);
}

export const hasExpenses = () => Boolean(db.prepare('SELECT 1 FROM expenses LIMIT 1').get());

/** The currency used most in a period (totals are kept per currency, never converted). */
export function mainCurrency(from: string, to: string): string {
  const r = db.prepare('SELECT currency, COUNT(*) AS n FROM expenses WHERE date BETWEEN ? AND ? GROUP BY currency ORDER BY n DESC LIMIT 1').get(from, to) as { currency: string } | undefined;
  return r?.currency ?? (db.prepare('SELECT currency FROM expenses ORDER BY id DESC LIMIT 1').get() as { currency: string } | undefined)?.currency ?? 'RUB';
}

export function moneyStats(from: string, to: string, currency = mainCurrency(from, to)) {
  const rows = db.prepare('SELECT * FROM expenses WHERE date BETWEEN ? AND ? AND currency = ? ORDER BY date DESC, id DESC').all(from, to, currency) as Expense[];
  const total = rows.reduce((a, e) => a + e.amount, 0);
  const byCat = new Map<string, number>();
  for (const e of rows) byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amount);
  const byDay = new Map<string, number>();
  for (const e of rows) byDay.set(e.date, (byDay.get(e.date) ?? 0) + e.amount);
  const others = db.prepare('SELECT currency, SUM(amount) AS s, COUNT(*) AS n FROM expenses WHERE date BETWEEN ? AND ? AND currency != ? GROUP BY currency').all(from, to, currency) as { currency: string; s: number; n: number }[];
  return { currency, total, count: rows.length, rows, byCat: [...byCat].sort((a, b) => b[1] - a[1]), byDay, others };
}

export const lineForModel = (e: Expense) => `$${e.id} ${e.date} ${money(e.amount, e.currency)} ${e.category}${e.note ? ` «${e.note}»` : ''}`;
export const recent = (n = 6) => db.prepare('SELECT * FROM expenses ORDER BY id DESC LIMIT ?').all(n) as Expense[];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function cardHtml(e: Expense): string {
  return `${catIcon(e.category)} <b>${money(e.amount, e.currency)}</b> · ${esc(e.category)}${e.note ? ` · ${esc(e.note)}` : ''}${e.date !== todayLocal() ? ` · ${dayLabel(e.date)}` : ''}`;
}
