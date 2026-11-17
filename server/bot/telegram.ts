// Minimal Telegram Bot API client (fetch + FormData, no dependencies).
const BASE = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');

export class TgError extends Error {
  code: number; description: string; retryAfter?: number;
  constructor(code: number, description: string, retryAfter?: number) {
    super(`Telegram ${code}: ${description}`);
    this.code = code; this.description = description; this.retryAfter = retryAfter;
  }
}

export class Telegram {
  private token: string;
  constructor(token: string) { this.token = token; }

  private url(method: string) { return `${BASE}/bot${this.token}/${method}`; }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, files?: Record<string, { data: Buffer; name: string; type: string }>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      if (files) {
        const fd = new FormData();
        for (const [k, v] of Object.entries(params)) if (v !== undefined) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
        for (const [k, f] of Object.entries(files)) fd.append(k, new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
        res = await fetch(this.url(method), { method: 'POST', body: fd });
      } else {
        res = await fetch(this.url(method), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
      }
      const j = (await res.json().catch(() => ({ ok: false, error_code: res.status, description: res.statusText }))) as { ok: boolean; result: T; error_code: number; description: string; parameters?: { retry_after?: number } };
      if (j.ok) return j.result;
      const retry = j.parameters?.retry_after;
      if (j.error_code === 429 && retry && attempt < 3) { await new Promise((r) => setTimeout(r, (retry + 1) * 1000)); continue; }
      throw new TgError(j.error_code, j.description, retry);
    }
  }

  async download(filePath: string): Promise<Buffer> {
    const res = await fetch(`${BASE}/file/bot${this.token}/${filePath}`);
    if (!res.ok) throw new Error(`download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
