import type { LlmProviderName } from '../../../_shared/llm';

export type GoldAnalystProvider = 'auto' | 'groq' | 'gemini' | 'openai';
export type GoldAnalystMode = 'fast' | 'balanced' | 'deep';

export interface GoldAnalystModel {
  id: string;
  label: string;
  mode: GoldAnalystMode;
}

export interface GoldAnalystProviderConfig {
  id: Exclude<GoldAnalystProvider, 'auto'>;
  label: string;
  configured: boolean;
  freeTier: boolean;
  models: GoldAnalystModel[];
  defaultModel: string;
}

const CATALOG: Array<Omit<GoldAnalystProviderConfig, 'configured'>> = [
  {
    id: 'groq',
    label: 'Groq',
    freeTier: true,
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', mode: 'fast' },
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', mode: 'balanced' },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    freeTier: true,
    defaultModel: 'gemini-3.6-flash',
    models: [
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', mode: 'fast' },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', mode: 'balanced' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', mode: 'deep' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    freeTier: false,
    defaultModel: 'gpt-5.4-mini',
    models: [
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', mode: 'fast' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', mode: 'balanced' },
      { id: 'gpt-5.4', label: 'GPT-5.4', mode: 'deep' },
    ],
  },
];

function providerConfigured(provider: Exclude<GoldAnalystProvider, 'auto'>): boolean {
  if (provider === 'groq') return Boolean(process.env.GROQ_API_KEY);
  if (provider === 'gemini') return Boolean(process.env.GEMINI_API_KEY);
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getGoldAnalystProviderCatalog(): GoldAnalystProviderConfig[] {
  return CATALOG.map((provider) => ({
    ...provider,
    models: provider.models.map((model) => ({ ...model })),
    configured: providerConfigured(provider.id),
  }));
}

export interface GoldAnalystProviderRoute {
  providerOrder: LlmProviderName[];
  modelOverrides: Partial<Record<LlmProviderName, string>>;
  requestedProvider: GoldAnalystProvider;
  requestedModel: string;
}

function providerForMode(
  mode: GoldAnalystMode,
): Exclude<GoldAnalystProvider, 'auto'> {
  if (mode === 'fast') return 'groq';
  if (mode === 'deep') return 'openai';
  return 'gemini';
}

function modelForMode(provider: GoldAnalystProviderConfig, mode: GoldAnalystMode): string {
  return provider.models.find((model) => model.mode === mode)?.id ?? provider.defaultModel;
}

export function resolveGoldAnalystProviderRoute(input: {
  provider: GoldAnalystProvider;
  model?: string;
  mode: GoldAnalystMode;
  allowFallback: boolean;
}): GoldAnalystProviderRoute | null {
  const catalog = getGoldAnalystProviderCatalog();
  const configured = catalog.filter((provider) => provider.configured);
  if (configured.length === 0) return null;

  const preferredId = input.provider === 'auto'
    ? providerForMode(input.mode)
    : input.provider;
  const preferred = catalog.find((provider) => provider.id === preferredId);
  const selectedModel = input.provider !== 'auto'
    && input.model
    && preferred?.models.some((model) => model.id === input.model)
    ? input.model
    : preferred
      ? modelForMode(preferred, input.mode)
      : '';

  // A normal Groq/Gemini request must not silently incur OpenAI charges.
  // OpenAI participates in fallback only when the user selected it or chose
  // the deep automatic route.
  const fallbackPool = configured.filter((provider) => (
    provider.id !== 'openai'
    || preferredId === 'openai'
    || (input.provider === 'auto' && input.mode === 'deep')
  ));
  const ordered = [
    ...(preferred?.configured ? [preferred] : []),
    ...(input.allowFallback
      ? fallbackPool.filter((provider) => provider.id !== preferred?.id)
      : []),
  ];
  if (ordered.length === 0) return null;

  const providerOrder = ordered.map((provider) => provider.id as LlmProviderName);
  const modelOverrides = Object.fromEntries(ordered.map((provider, index) => [
    provider.id,
    index === 0 && selectedModel
      ? selectedModel
      : modelForMode(provider, input.mode),
  ])) as Partial<Record<LlmProviderName, string>>;

  return {
    providerOrder,
    modelOverrides,
    requestedProvider: input.provider,
    requestedModel: selectedModel,
  };
}

export function parseGoldAnalystProvider(value: unknown): GoldAnalystProvider {
  return value === 'auto' || value === 'gemini' || value === 'openai' || value === 'groq'
    ? value
    : 'groq';
}

export function parseGoldAnalystMode(value: unknown): GoldAnalystMode {
  return value === 'fast' || value === 'deep' || value === 'balanced'
    ? value
    : 'balanced';
}
