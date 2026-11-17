// Monthly budgets per category and recurring payments (subscriptions).
//   • a budget warns once at 80% and once at 100% of the month's limit;
//   • a subscription reminds `remind_days` before the charge and, on the day, records the expense itself.
import { db, kvGet, kvSet } from '../db.ts';
import { todayLocal, nowLocal, normTime, dayLabel } from './store.ts';
import { addDays } from '../lib/time.ts';
import { CATEGORIES, CURRENCIES, catIcon, money, addExpense } from './money.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  amount   REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'RUB'
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  amount      REAL NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'RUB',
  category    TEXT NOT NULL DEFAULT 'Подписки',
  cycle       TEXT NOT NULL DEFAULT 'monthly',   -- weekly | monthly | yearly
  next_date   TEXT NOT NULL,                     -- local 'YYYY-MM-DD' of the next charge
  remind_days INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
`);

const CATS = new Set(CATEGORIES.map(([c]) => c));
function cat(c: unknown): string {
  const s = String(c ?? '').trim();
  const hit = CATEGORIES.find(([x]) => x.toLowerCase() === s.toLowerCase());
  if (!hit) throw new Error(`Категория: одна из ${[...CATS].join(', ')}`);
  return hit[0];
}
function cur(c: unknown): string {
  const s = String(c ?? 'RUB').toUpperCase();
  if (!CURRENCIES[s]) throw new Error(`Валюта: ${Object.keys(CURRENCIES).join(', ')}`);
  return s;
}
function amt(a: unknown): number {
  const n = Number(String(a ?? '').replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) throw new Error('Сумма должна быть больше нуля');
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------- budgets

export interface Budget { category: string; amount: number; currency: string }
export interface BudgetStatus extends Budget { icon: string; spent: number; pct: number; left: number }

export function setBudget(category: unknown, amount: unknown, currency?: unknown): Budget {
  const b = { category: cat(category), amount: amt(amount), currency: cur(currency) };
  db.prepare('INSERT OR REPLACE INTO budgets(category, amount, currency) VALUES(?, ?, ?)').run(b.category, b.amount, b.currency);
  return b;
}
export function deleteBudget(category: unknown): Budget {
  const c = cat(category);
  const b = db.prepare('SELECT * FROM budgets WHERE category = ?').get(c) as Budget | undefined;
  if (!b) throw new Error(`Бюджета на «${c}» нет`);
  db.prepare('DELETE FROM budgets WHERE category = ?').run(c);
  return b;
}
export const listBudgets = () => db.prepare('SELECT * FROM budgets ORDER BY category').all() as Budget[];

/** This month's spending against each budget (same currency only — no conversion). */
export function budgetStatus(month = todayLocal().slice(0, 7)): BudgetStatus[] {
  const spentQ = db.prepare('SELECT COALESCE(SUM(amount), 0) s FROM expenses WHERE category = ? AND currency = ? AND substr(date, 1, 7) = ?');
  return listBudgets().map((b) => {
    const spent = Number((spentQ.get(b.category, b.currency, month) as { s: number }).s);
    return { ...b, icon: catIcon(b.category), spent, pct: spent / b.amount, left: b.amount - spent };
  }).sort((a, b) => b.pct - a.pct);
}

/** After an expense: a one-time warning per month when a budget crosses 80% and then 100%. */
export function budgetAlert(category: string, date: string): string | null {
  const month = date.slice(0, 7);
  if (month !== todayLocal().slice(0, 7)) return null;
  const s = budgetStatus(month).find((x) => x.category === category);
  if (!s) return null;
  const level = s.pct >= 1 ? 100 : s.pct >= 0.8 ? 80 : 0;
  const k = `budget:alert:${category}:${month}`;
  if (level <= Number(kvGet(k) || 0)) return null;
  kvSet(k, String(level));
  return level === 100
    ? `🚨 Бюджет «${s.icon} ${category}» превышен: ${money(s.spent, s.currency)} из ${money(s.amount, s.currency)} (${Math.round(s.pct * 100)}%).`
    : `⚠️ Бюджет «${s.icon} ${category}»: потрачено ${Math.round(s.pct * 100)}% — ${money(s.spent, s.currency)} из ${money(s.amount, s.currency)}, осталось ${money(s.left, s.currency)}.`;
}

export const budgetLine = (s: BudgetStatus) => `B:${s.category} ${money(s.spent, s.currency)} из ${money(s.amount, s.currency)} (${Math.round(s.pct * 100)}%)`;

// ---------------------------------------------------------------- subscriptions

export type Cycle = 'weekly' | 'monthly' | 'yearly';
export interface Sub { id: number; title: string; amount: number; currency: string; category: string; cycle: Cycle; next_date: string; remind_days: number; active: number; created_at: string }

const CYCLE_RU: Record<Cycle, string> = { weekly: 'в неделю', monthly: 'в месяц', yearly: 'в год' };
function cycle(c: unknown): Cycle {
  const s = String(c ?? 'monthly').toLowerCase();
  if (/week|нед/.test(s)) return 'weekly';
  if (/year|год|annual/.test(s)) return 'yearly';
  return 'monthly';
}
function nextAfter(date: string, c: Cycle): string {
  if (c === 'weekly') return addDays(date, 7);
  const [y, m, d] = date.split('-').map(Number);
  const ym = c === 'yearly' ? [y + 1, m] : m === 12 ? [y + 1, 1] : [y, m + 1];
  const last = new Date(Date.UTC(ym[0], ym[1], 0)).getUTCDate(); // 31st → last day of a shorter month
  return `${ym[0]}-${String(ym[1]).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const getSub = (id: number) => (db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Sub | undefined) ?? null;

export function addSub(f: { title: unknown; amount: unknown; currency?: unknown; category?: unknown; cycle?: unknown; next_date?: unknown; remind_days?: unknown }): Sub {
  const title = String(f.title ?? '').trim();
  if (!title) throw new Error('Нужно название подписки');
  const next = normTime(String(f.next_date ?? ''))?.slice(0, 10) ?? todayLocal();
  const r = db.prepare('INSERT INTO subscriptions(title, amount, currency, category, cycle, next_date, remind_days, active, created_at) VALUES(?,?,?,?,?,?,?,1,?)')
    .run(title, amt(f.amount), cur(f.currency), f.category ? cat(f.category) : 'Подписки', cycle(f.cycle), next, Math.max(0, Math.min(14, Number(f.remind_days ?? 1) || 0)), nowLocal());
  return getSub(Number(r.lastInsertRowid))!;
}
export function updateSub(id: number, f: Record<string, unknown>): Sub {
  const old = getSub(id);
  if (!old) throw new Error(`Нет подписки S#${id}`);
  const it = { ...old };
  if (f.title) it.title = String(f.title).trim();
  if (f.amount !== undefined) it.amount = amt(f.amount);
  if (f.currency) it.currency = cur(f.currency);
  if (f.category) it.category = cat(f.category);
  if (f.cycle) it.cycle = cycle(f.cycle);
  if (f.next_date) it.next_date = normTime(String(f.next_date))?.slice(0, 10) ?? it.next_date;
  if (f.remind_days !== undefined) it.remind_days = Math.max(0, Math.min(14, Number(f.remind_days) || 0));
  if (f.active !== undefined) it.active = f.active ? 1 : 0;
  db.prepare('UPDATE subscriptions SET title=?, amount=?, currency=?, category=?, cycle=?, next_date=?, remind_days=?, active=? WHERE id=?')
    .run(it.title, it.amount, it.currency, it.category, it.cycle, it.next_date, it.remind_days, it.active, id);
  return getSub(id)!;
}
export function deleteSub(id: number): Sub {
  const it = getSub(id);
  if (!it) throw new Error(`Нет подписки S#${id}`);
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
  return it;
}
export const listSubs = () => db.prepare('SELECT * FROM subscriptions ORDER BY active DESC, next_date').all() as Sub[];

/** Monthly cost per currency (weekly × 52/12, yearly / 12). */
export function subsMonthly(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of listSubs().filter((x) => x.active)) out[s.currency] = (out[s.currency] ?? 0) + (s.cycle === 'weekly' ? s.amount * 52 / 12 : s.cycle === 'yearly' ? s.amount / 12 : s.amount);
  return out;
}

export const subLine = (s: Sub) => `S#${s.id} «${s.title}» ${money(s.amount, s.currency)} ${CYCLE_RU[s.cycle]}, следующее списание ${s.next_date}${s.active ? '' : ' [отключена]'} (${s.category})`;
export const subLabel = (s: Sub) => `${money(s.amount, s.currency)} ${CYCLE_RU[s.cycle]}`;

/**
 * Daily: reminders `remind_days` before a charge, and on the charge day the expense is recorded and the
 * date moves on. Missed days (server off) are caught up, at most 3 charges per subscription.
 */
export function runSubs(today = todayLocal()): string[] {
  const out: string[] = [];
  for (const s of listSubs().filter((x) => x.active)) {
    let next = s.next_date, charged = 0;
    while (next <= today && charged < 3) {
      const e = addExpense({ amount: s.amount, currency: s.currency, category: s.category, note: s.title, date: next });
      const warn = budgetAlert(s.category, next);
      out.push(`💳 Списание «${s.title}»: ${money(s.amount, s.currency)} — записал в траты ($${e.id}).${warn ? '\n' + warn : ''}`);
      next = nextAfter(next, s.cycle); charged++;
    }
    while (next <= today) next = nextAfter(next, s.cycle);
    if (next !== s.next_date) db.prepare('UPDATE subscriptions SET next_date = ? WHERE id = ?').run(next, s.id);
    const remindOn = addDays(next, -s.remind_days), k = `sub:remind:${s.id}:${next}`;
    if (s.remind_days > 0 && remindOn <= today && next > today && !kvGet(k)) {
      kvSet(k, '1');
      out.push(`🔔 ${dayLabel(next, today).replace(/^./, (c) => c.toUpperCase())} спишется «${s.title}» — ${money(s.amount, s.currency)}.`);
    }
  }
  return out;
}

export function subsView() {
  const today = todayLocal();
  return listSubs().map((s) => ({ id: s.id, title: s.title, icon: catIcon(s.category), price: subLabel(s), next: dayLabel(s.next_date, today), soon: s.active && s.next_date <= addDays(today, 3), active: Boolean(s.active) }));
}
