// Which LLM the assistant talks to. Any OpenAI-compatible API works (Groq by default — it has a free tier;
// OpenAI, OpenRouter, a local Ollama/LM Studio …). Speech-to-text uses the same provider unless set apart.
const trim = (u: string) => u.replace(/\/+$/, '');

export const llm = {
  base: () => trim(process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1'),
  key: () => process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '',
  /** Groq's gpt-oss models have a built-in web browser; other providers get no web search. */
  hasWebSearch: () => /api\.groq\.com/.test(llm.base()) && process.env.WEB_SEARCH !== '0',
};

export const stt = {
  base: () => trim(process.env.STT_BASE_URL || llm.base()),
  key: () => process.env.STT_API_KEY || llm.key(),
  model: () => process.env.STT_MODEL || process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo',
};

export const authHeader = (key: string) => (key ? { authorization: `Bearer ${key}` } : {});
