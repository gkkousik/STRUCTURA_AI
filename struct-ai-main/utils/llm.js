/**
 * Multi-provider LLM client with automatic failover.
 *
 * Every provider below speaks the OpenAI-compatible chat-completions format,
 * so one code path handles all of them. For each request we walk a list of
 * (provider × model × API key) candidates and use the first one that works.
 *
 * - 429 (quota / rate limit)  -> that candidate is put on cooldown, next one is tried
 * - 401/403 (bad/revoked key) -> long cooldown, next one is tried
 * - 404/400 (model retired)   -> long cooldown, next one is tried
 * - 5xx / timeout             -> short cooldown, next one is tried
 *
 * Each provider accepts several comma-separated keys (e.g. GROQ_API_KEY=k1,k2),
 * and each key has its own quota, so more keys = more headroom.
 */
const axios = require('axios');
const { DIAGRAM_PROMPTS, SYSTEM_PROMPT } = require('./diagramCatalogue');

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Model IDs change over time — override any of them via env vars
// (e.g. GROQ_MODELS=model-a,model-b) without touching the code.
function buildProviders() {
  return [
    {
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      keys: list(process.env.GROQ_API_KEY),
      models: list(process.env.GROQ_MODELS).length
        ? list(process.env.GROQ_MODELS)
        : ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    },
    {
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      keys: list(process.env.GEMINI_API_KEY),
      models: list(process.env.GEMINI_MODELS).length
        ? list(process.env.GEMINI_MODELS)
        : ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    },
    {
      name: 'cerebras',
      url: 'https://api.cerebras.ai/v1/chat/completions',
      keys: list(process.env.CEREBRAS_API_KEY),
      models: list(process.env.CEREBRAS_MODELS).length
        ? list(process.env.CEREBRAS_MODELS)
        : ['llama-3.3-70b'],
    },
    {
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      keys: list(process.env.OPENROUTER_API_KEY),
      models: list(process.env.OPENROUTER_MODELS).length
        ? list(process.env.OPENROUTER_MODELS)
        : ['meta-llama/llama-3.3-70b-instruct:free'],
    },
  ];
}

// candidateId -> timestamp (ms) until which we skip it
const cooldowns = new Map();

const TOTAL_BUDGET_MS = 55000; // stay under typical host request timeouts
const PER_CALL_TIMEOUT_MS = 25000;

function buildCandidates() {
  let providers = buildProviders();
  const order = list(process.env.LLM_PROVIDER_ORDER);
  if (order.length) {
    providers = order
      .map((n) => providers.find((p) => p.name === n))
      .filter(Boolean);
  }
  const out = [];
  for (const p of providers) {
    for (const model of p.models) {
      p.keys.forEach((key, i) => {
        out.push({ id: `${p.name}|${model}|${i}`, provider: p, model, key });
      });
    }
  }
  // Candidates that are not cooling down go first; cooled-down ones are kept
  // as a last resort in case they have recovered.
  const now = Date.now();
  const ready = out.filter((c) => (cooldowns.get(c.id) || 0) <= now);
  const waiting = out.filter((c) => (cooldowns.get(c.id) || 0) > now);
  return { all: [...ready, ...waiting], total: out.length };
}

function cooldownFor(status, headers) {
  if (status === 429) {
    const ra = Number(headers && headers['retry-after']);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 6 * 3600 * 1000);
    return 5 * 60 * 1000;
  }
  if (status === 401 || status === 403) return 60 * 60 * 1000;
  if (status === 400 || status === 404) return 60 * 60 * 1000;
  return 30 * 1000; // 5xx, timeouts, network errors
}

async function callLLM(projectName, diagramType) {
  const { all, total } = buildCandidates();
  if (total === 0) {
    throw new Error(
      'No AI provider configured. Set at least one of GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY or OPENROUTER_API_KEY.'
    );
  }

  const template = DIAGRAM_PROMPTS[diagramType] || '';
  const userPrompt = template.replace(/PROJECT_NAME/g, projectName);
  const started = Date.now();
  const errors = [];

  for (const c of all) {
    if (Date.now() - started > TOTAL_BUDGET_MS) break;

    const headers = {
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
    };
    if (c.provider.name === 'openrouter') {
      headers['X-Title'] = 'Structura AI';
    }

    try {
      console.log(`[llm] try provider=${c.provider.name} model=${c.model} diagram=${diagramType}`);
      const resp = await axios.post(
        c.provider.url,
        {
          model: c.model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 2048,
          temperature: 0.2,
        },
        { headers, timeout: PER_CALL_TIMEOUT_MS, validateStatus: () => true }
      );

      if (resp.status < 200 || resp.status >= 300) {
        cooldowns.set(c.id, Date.now() + cooldownFor(resp.status, resp.headers));
        errors.push(`${c.provider.name}/${c.model}: HTTP ${resp.status}`);
        continue;
      }

      const text = resp.data?.choices?.[0]?.message?.content;
      if (!text || !/@start/i.test(text)) {
        // Model answered but didn't produce a diagram — try the next one.
        errors.push(`${c.provider.name}/${c.model}: unusable output`);
        continue;
      }

      console.log(`[llm] success provider=${c.provider.name} model=${c.model}`);
      return text;
    } catch (err) {
      cooldowns.set(c.id, Date.now() + cooldownFor(0));
      errors.push(`${c.provider.name}/${c.model}: ${err.code || err.message}`);
    }
  }

  console.error('[llm] all candidates failed:', errors.join(' | '));
  throw new Error(
    'The AI service is temporarily busy. Please try again in a minute.'
  );
}

module.exports = { callLLM };
