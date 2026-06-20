import { HttpError } from './errors.js';

const DETAIL_LEVELS = ['BRIEF', 'BALANCED', 'RICH'];
const STRICTNESS_LEVELS = ['LOOSE', 'STANDARD', 'STRICT'];
const TRIGGER_MODES = ['ACTION', 'ASSISTED', 'MANUAL', 'ROUND'];

const DEFAULT_AI_SETTINGS = {
  baseUrl: '',
  model: '',
  apiKey: '',
  dmStyle: '调查、悬疑、克制，不替玩家做决定。',
  narrativeDetail: 'BALANCED',
  rulesStrictness: 'STANDARD',
  allowModuleExpansion: false,
  triggerMode: 'ACTION',
  keeperReviewRequired: false,
  contentBoundaries: '',
  temperature: 0.8
};

function parseSettings(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function text(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function enumValue(value, fallback, allowed) {
  const normalized = String(value || fallback).trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : fallback;
}

function temperatureValue(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(2, Math.round(number * 100) / 100));
}

export function normalizeAiSettings(input, previous = {}) {
  const current = { ...DEFAULT_AI_SETTINGS, ...parseSettings(previous) };
  const raw = parseSettings(input);

  if (raw.baseUrl !== undefined) current.baseUrl = text(raw.baseUrl, 240).replace(/\/+$/, '');
  if (raw.model !== undefined) current.model = text(raw.model, 120);
  if (raw.apiKey !== undefined && text(raw.apiKey, 400)) current.apiKey = text(raw.apiKey, 400);
  if (raw.clearApiKey) current.apiKey = '';
  if (raw.dmStyle !== undefined) current.dmStyle = text(raw.dmStyle, 1000);
  if (raw.narrativeDetail !== undefined) {
    current.narrativeDetail = enumValue(raw.narrativeDetail, DEFAULT_AI_SETTINGS.narrativeDetail, DETAIL_LEVELS);
  }
  if (raw.rulesStrictness !== undefined) {
    current.rulesStrictness = enumValue(raw.rulesStrictness, DEFAULT_AI_SETTINGS.rulesStrictness, STRICTNESS_LEVELS);
  }
  if (raw.allowModuleExpansion !== undefined) current.allowModuleExpansion = Boolean(raw.allowModuleExpansion);
  if (raw.triggerMode !== undefined) {
    current.triggerMode = enumValue(raw.triggerMode, DEFAULT_AI_SETTINGS.triggerMode, TRIGGER_MODES);
  }
  if (raw.keeperReviewRequired !== undefined) current.keeperReviewRequired = Boolean(raw.keeperReviewRequired);
  if (raw.contentBoundaries !== undefined) current.contentBoundaries = text(raw.contentBoundaries, 1600);
  if (raw.temperature !== undefined) current.temperature = temperatureValue(raw.temperature, current.temperature);

  return current;
}

export function publicAiSettings(settings) {
  const normalized = normalizeAiSettings({}, settings);
  const { apiKey, ...publicSettings } = normalized;
  return {
    ...publicSettings,
    apiKeyConfigured: Boolean(apiKey)
  };
}

export function roomRuntimeAiConfig(globalConfig, settings) {
  const normalized = normalizeAiSettings({}, settings);
  return {
    ...globalConfig,
    baseUrl: normalized.baseUrl || globalConfig.baseUrl,
    apiKey: normalized.apiKey || globalConfig.apiKey,
    model: normalized.model || globalConfig.model,
    temperature: normalized.temperature
  };
}

export function assertAiSettingsInput(input) {
  const settings = parseSettings(input);
  if (settings.baseUrl && !/^https?:\/\//i.test(String(settings.baseUrl))) {
    throw new HttpError(400, 'AI base URL must start with http:// or https://');
  }
  return settings;
}

export { DEFAULT_AI_SETTINGS, DETAIL_LEVELS, STRICTNESS_LEVELS, TRIGGER_MODES };
