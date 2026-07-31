export type GoldAnalystProvider = 'auto' | 'groq' | 'gemini' | 'openai';
export type GoldAnalystMode = 'fast' | 'balanced' | 'deep';

export interface GoldAnalystSettings {
  provider: GoldAnalystProvider;
  model: string;
  mode: GoldAnalystMode;
  allowFallback: boolean;
}

export interface GoldAnalystModelConfig {
  id: string;
  label: string;
  mode: GoldAnalystMode;
}

export interface GoldAnalystProviderConfig {
  id: Exclude<GoldAnalystProvider, 'auto'>;
  label: string;
  configured: boolean;
  freeTier: boolean;
  models: GoldAnalystModelConfig[];
  defaultModel: string;
}

export interface GoldAnalystReadinessCategory {
  id: string;
  label: string;
  score: number;
  maxScore: number;
}

export interface GoldAnalystReadiness {
  score: number;
  level: 'full' | 'limited' | 'insufficient';
  predictionAllowed: boolean;
  categories: GoldAnalystReadinessCategory[];
  missing: string[];
  warnings: string[];
}

export interface GoldAnalystConfigResponse {
  providers: GoldAnalystProviderConfig[];
  defaults: {
    provider: GoldAnalystProvider;
    mode: GoldAnalystMode;
    allowFallback: boolean;
  };
  readiness: GoldAnalystReadiness;
  sources: string[];
  asOf: string;
  security: string;
}

const STORAGE_KEY = 'wm-gold-analyst-settings-v1';
export const GOLD_ANALYST_SETTINGS_CHANGED = 'gold-analyst-settings-changed';

const DEFAULT_SETTINGS: GoldAnalystSettings = {
  provider: 'groq',
  model: 'llama-3.3-70b-versatile',
  mode: 'balanced',
  allowFallback: true,
};

function isProvider(value: unknown): value is GoldAnalystProvider {
  return value === 'auto' || value === 'groq' || value === 'gemini' || value === 'openai';
}

function isMode(value: unknown): value is GoldAnalystMode {
  return value === 'fast' || value === 'balanced' || value === 'deep';
}

export function getGoldAnalystSettings(): GoldAnalystSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<GoldAnalystSettings>;
    return {
      provider: isProvider(parsed.provider) ? parsed.provider : DEFAULT_SETTINGS.provider,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_SETTINGS.model,
      mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_SETTINGS.mode,
      allowFallback: typeof parsed.allowFallback === 'boolean'
        ? parsed.allowFallback
        : DEFAULT_SETTINGS.allowFallback,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setGoldAnalystSettings(
  update: Partial<GoldAnalystSettings>,
): GoldAnalystSettings {
  const current = getGoldAnalystSettings();
  const next: GoldAnalystSettings = {
    provider: isProvider(update.provider) ? update.provider : current.provider,
    model: typeof update.model === 'string' ? update.model : current.model,
    mode: isMode(update.mode) ? update.mode : current.mode,
    allowFallback: typeof update.allowFallback === 'boolean'
      ? update.allowFallback
      : current.allowFallback,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable in private/embedded contexts. The current
    // interaction still uses the in-memory values supplied by the control.
  }
  window.dispatchEvent(new CustomEvent(GOLD_ANALYST_SETTINGS_CHANGED, { detail: next }));
  return next;
}

export async function fetchGoldAnalystConfig(
  signal?: AbortSignal,
): Promise<GoldAnalystConfigResponse> {
  const response = await fetch('/api/gold-analyst', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`Gold Analyst config HTTP ${response.status}`);
  return response.json() as Promise<GoldAnalystConfigResponse>;
}
