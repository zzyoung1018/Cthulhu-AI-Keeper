import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function readBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function readNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const dataDir = resolve(env.DATA_DIR || './data');
  mkdirSync(dataDir, { recursive: true });

  return {
    host: env.HOST || '127.0.0.1',
    port: readNumber(env.PORT, 4173),
    dataDir,
    dbPath: resolve(dataDir, 'dm-online.db'),
    ai: {
      baseUrl: (env.AI_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.AI_API_KEY || '',
      model: env.AI_MODEL || '',
      temperature: readNumber(env.AI_TEMPERATURE, 0.8),
      timeoutMs: readNumber(env.AI_TIMEOUT_MS, 120_000),
      localFallback: readBoolean(env.AI_LOCAL_FALLBACK, true)
    }
  };
}

export function isAiConfigured(aiConfig) {
  return Boolean(aiConfig.baseUrl && aiConfig.apiKey && aiConfig.model);
}
