// Telegram Mini App initData validation (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
import crypto from 'node:crypto';

export interface TgUser { id: number; first_name?: string; username?: string }

/** Returns the signed-in Telegram user, or null if the signature is wrong or too old. */
export function checkInitData(initData: string, botToken: string, maxAgeSec = 24 * 3600): TgUser | null {
  if (!initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(check).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try {
    const user = JSON.parse(params.get('user') ?? 'null') as TgUser | null;
    return user && typeof user.id === 'number' ? user : null;
  } catch { return null; }
}
