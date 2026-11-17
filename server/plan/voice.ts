import { stt, authHeader } from './llm.ts';
// Voice messages → text via Groq's hosted Whisper (the owner agreed to send voice notes there).
export const voiceEnabled = () => Boolean(stt.key()) || Boolean(process.env.STT_BASE_URL);

export async function transcribe(audio: Buffer, filename = 'voice.ogg'): Promise<string> {
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(audio)]), filename);
  fd.append('model', stt.model());
  fd.append('language', 'ru');
  fd.append('response_format', 'json');
  const res = await fetch(`${stt.base()}/audio/transcriptions`, {
    method: 'POST', headers: authHeader(stt.key()), body: fd,
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return String(((await res.json()) as { text?: string }).text ?? '').trim();
}
