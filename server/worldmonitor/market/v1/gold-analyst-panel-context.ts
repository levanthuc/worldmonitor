import { getCachedJsonBatch } from '../../../_shared/redis';

const PUBLIC_BOOTSTRAP_BASE_URL = 'https://api.worldmonitor.app/api/bootstrap';
const PUBLIC_BOOTSTRAP_ORIGIN = 'https://worldmonitor.app';
const PUBLIC_BOOTSTRAP_TIMEOUT_MS = 10_000;
const HYPERLIQUID_SAMPLE_INTERVAL_MINUTES = 5;
const ONE_HOUR_MINUTES = 60;

export const GOLD_ANALYST_PANEL_CACHE_KEYS = {
  fearGreed: 'market:fear-greed:v1',
  economicStress: 'economic:stress-index:v1',
  hyperliquidFlow: 'market:hyperliquid:flow:v1',
  sanctionsPressure: 'sanctions:pressure:v1',
  ucdpEvents: 'conflict:ucdp-events-bootstrap:v1',
  riskScores: 'risk:scores:sebuf:stale:v8',
  predictionMarkets: 'prediction:markets-bootstrap:v1',
  marketQuotes: 'market:stocks-bootstrap:v1',
  cpi: 'economic:fred:v1:CPIAUCSL:0',
  fedFunds: 'economic:fred:v1:FEDFUNDS:0',
} as const;

export type GoldAnalystPanelSourceId = keyof typeof GOLD_ANALYST_PANEL_CACHE_KEYS;
export type GoldAnalystPanelSourceProvenance =
  | 'cache'
  | 'worldmonitor-bootstrap'
  | 'official-source'
  | 'unavailable';

export interface GoldAnalystPanelSourceAvailability {
  available: boolean;
  cacheKey: string;
  provenance: GoldAnalystPanelSourceProvenance;
  asOf: string | null;
  recordCount: number;
  note?: string;
}

export type GoldAnalystPanelSourceAvailabilityMap = Record<
  GoldAnalystPanelSourceId,
  GoldAnalystPanelSourceAvailability
>;

export interface GoldAnalystCpiObservation {
  date: string;
  value: number;
}

export interface GoldAnalystCpiYoY {
  currentDate: string;
  currentValue: number;
  priorDate: string;
  priorValue: number;
  yoyPct: number;
}

export interface GoldAnalystOiDelta {
  current: number;
  oneHourAgo: number;
  absolute: number;
  pct: number;
  sampleIntervalMinutes: number;
  intervals: number;
}

export interface GoldAnalystPredictionMarketInput {
  title?: unknown;
  yesPrice?: unknown;
  volume?: unknown;
  url?: unknown;
  endDate?: unknown;
  source?: unknown;
}

export interface GoldAnalystRelevantPredictionMarket {
  title: string;
  yesPrice: number | null;
  volume: number;
  url: string;
  endDate: string | null;
  source: string;
  relevanceScore: number;
  relevanceSignals: string[];
}

export interface GoldAnalystConflictEventInput {
  id?: unknown;
  dateStart?: unknown;
  dateEnd?: unknown;
  country?: unknown;
  sideA?: unknown;
  sideB?: unknown;
  deathsBest?: unknown;
  deathsLow?: unknown;
  deathsHigh?: unknown;
  violenceType?: unknown;
  sourceOriginal?: unknown;
}

export interface GoldAnalystConflictEvent {
  id: string;
  dateStart: string;
  dateEnd: string | null;
  country: string;
  sideA: string;
  sideB: string;
  deathsBest: number;
  deathsLow: number;
  deathsHigh: number;
  violenceType: string;
  sourceOriginal: string;
}

export interface GoldAnalystConflictCountryAggregate {
  country: string;
  events30d: number;
  deathsBest30d: number;
}

export interface GoldAnalystConflictAggregate {
  validEventCount: number;
  events24h: number;
  events7d: number;
  events30d: number;
  deathsBest24h: number;
  deathsBest7d: number;
  deathsBest30d: number;
  latestEventAt: string | null;
  topCountries30d: GoldAnalystConflictCountryAggregate[];
  recentEvents: GoldAnalystConflictEvent[];
}

export interface GoldAnalystFearGreedCategory {
  id: string;
  score: number | null;
  weight: number | null;
  contribution: number | null;
  degraded: boolean;
  inputs: Record<string, unknown>;
}

export interface GoldAnalystFearGreedInput {
  score: number;
  label: string;
  previousScore: number | null;
  categories: GoldAnalystFearGreedCategory[];
  headerMetrics: Record<string, Record<string, unknown> | null>;
  asOf: string | null;
}

export interface GoldAnalystEconomicStressComponent {
  id: string;
  label: string;
  rawValue: number | null;
  score: number | null;
  weight: number | null;
  missing: boolean;
}

export interface GoldAnalystEconomicStressInput {
  compositeScore: number;
  label: string;
  components: GoldAnalystEconomicStressComponent[];
  asOf: string | null;
}

export interface GoldAnalystHyperliquidAsset {
  symbol: string;
  display: string;
  assetClass: string;
  group: string;
  funding: number | null;
  openInterest: number | null;
  markPrice: number | null;
  oraclePrice: number | null;
  dayNotional: number | null;
  fundingScore: number | null;
  volumeScore: number | null;
  oiScore: number | null;
  basisScore: number | null;
  composite: number | null;
  oiDelta1h: GoldAnalystOiDelta | null;
  sparkFunding: number[];
  sparkOi: number[];
  sparkScore: number[];
  warmup: boolean;
  stale: boolean;
  alerts: string[];
}

export interface GoldAnalystHyperliquidInput {
  assets: GoldAnalystHyperliquidAsset[];
  warmup: boolean;
  asOf: string | null;
}

export interface GoldAnalystSanctionsCountry {
  countryCode: string;
  countryName: string;
  entryCount: number;
  newEntryCount: number;
  vesselCount: number;
  aircraftCount: number;
}

export interface GoldAnalystSanctionsProgram {
  program: string;
  entryCount: number;
  newEntryCount: number;
}

export interface GoldAnalystSanctionsEntry {
  id: string;
  name: string;
  entityType: string;
  countryCodes: string[];
  countryNames: string[];
  programs: string[];
  effectiveAt: string | null;
  isNew: boolean;
}

export interface GoldAnalystSanctionsInput {
  totalCount: number;
  newEntryCount: number;
  vesselCount: number;
  aircraftCount: number;
  datasetDate: string | null;
  countries: GoldAnalystSanctionsCountry[];
  programs: GoldAnalystSanctionsProgram[];
  recentEntries: GoldAnalystSanctionsEntry[];
  asOf: string | null;
}

export interface GoldAnalystCountryRisk {
  region: string;
  combinedScore: number;
  dynamicScore: number | null;
  trend: string;
  advisoryLevel: string;
  eventMultiplier: number | null;
  computedAt: string | null;
}

export interface GoldAnalystStrategicRisk {
  region: string;
  level: string;
  score: number;
  factors: string[];
  trend: string;
}

export interface GoldAnalystRiskInput {
  degraded: boolean;
  stale: boolean;
  topCountryRisks: GoldAnalystCountryRisk[];
  strategicRisks: GoldAnalystStrategicRisk[];
  asOf: string | null;
}

export interface GoldAnalystMarketQuote {
  symbol: string;
  name: string;
  display: string;
  price: number;
  changePct: number | null;
  sparkline: number[];
}

export interface GoldAnalystMarketBreadth {
  quoteCount: number;
  advancing: number;
  declining: number;
  unchanged: number;
  averageChangePct: number | null;
}

export interface GoldAnalystMarketInput {
  breadth: GoldAnalystMarketBreadth;
  broadIndices: GoldAnalystMarketQuote[];
  leaders: GoldAnalystMarketQuote[];
  laggards: GoldAnalystMarketQuote[];
}

export interface GoldAnalystFredSeriesInput {
  seriesId: string;
  title: string;
  units: string;
  frequency: string;
  observations: GoldAnalystCpiObservation[];
  asOf: string | null;
}

export interface GoldAnalystMacroInput {
  cpi: GoldAnalystFredSeriesInput | null;
  cpiYoY: GoldAnalystCpiYoY | null;
  fedFunds: GoldAnalystFredSeriesInput | null;
  latestFedFundsRate: number | null;
}

export interface GoldAnalystPanelContext {
  assembledAt: string;
  asOf: string;
  usedLocalBootstrapFallback: boolean;
  sourceAvailability: GoldAnalystPanelSourceAvailabilityMap;
  fearGreed: GoldAnalystFearGreedInput | null;
  economicStress: GoldAnalystEconomicStressInput | null;
  hyperliquidMetals: GoldAnalystHyperliquidInput | null;
  sanctions: GoldAnalystSanctionsInput | null;
  conflicts: GoldAnalystConflictAggregate | null;
  risks: GoldAnalystRiskInput | null;
  predictionMarkets: GoldAnalystRelevantPredictionMarket[];
  markets: GoldAnalystMarketInput | null;
  macro: GoldAnalystMacroInput;
}

export interface LoadGoldAnalystPanelContextOptions {
  cacheReader?: (
    keys: string[],
    raw?: boolean,
  ) => Promise<Map<string, unknown>>;
  fetchFn?: typeof fetch;
  isLocalDev?: boolean;
  now?: () => number;
}

interface SourceDefinition {
  id: GoldAnalystPanelSourceId;
  cacheKey: string;
  bootstrapName?: string;
}

interface RawFredSeries {
  seriesId?: unknown;
  title?: unknown;
  units?: unknown;
  frequency?: unknown;
  observations?: unknown;
}

interface ParsedSource {
  raw: unknown;
  provenance: GoldAnalystPanelSourceProvenance;
}

const SOURCE_DEFINITIONS: readonly SourceDefinition[] = [
  {
    id: 'fearGreed',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.fearGreed,
    bootstrapName: 'fearGreedIndex',
  },
  {
    id: 'economicStress',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.economicStress,
    bootstrapName: 'economicStress',
  },
  {
    id: 'hyperliquidFlow',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.hyperliquidFlow,
    bootstrapName: 'hyperliquidFlow',
  },
  {
    id: 'sanctionsPressure',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.sanctionsPressure,
    bootstrapName: 'sanctionsPressure',
  },
  {
    id: 'ucdpEvents',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.ucdpEvents,
    bootstrapName: 'ucdpEvents',
  },
  {
    id: 'riskScores',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.riskScores,
    bootstrapName: 'riskScores',
  },
  {
    id: 'predictionMarkets',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.predictionMarkets,
    bootstrapName: 'predictions',
  },
  {
    id: 'marketQuotes',
    cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.marketQuotes,
    bootstrapName: 'marketQuotes',
  },
  { id: 'cpi', cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.cpi },
  { id: 'fedFunds', cacheKey: GOLD_ANALYST_PANEL_CACHE_KEYS.fedFunds },
] as const;

const DIRECT_PREDICTION_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ['gold', /\b(?:gold|bullion|precious metals?)\b/i],
  ['silver', /\bsilver\b/i],
  ['inflation', /\b(?:inflation|cpi|consumer prices?)\b/i],
  ['Federal Reserve/rates', /\b(?:federal reserve|fed\b|interest rates?|rate cuts?|rate hikes?)\b/i],
  ['US dollar', /\b(?:u\.?s\.? dollar|dollar index|dxy)\b/i],
  ['Treasury yields', /\b(?:treasur(?:y|ies)|bond yields?|real yields?)\b/i],
  ['central banks', /\bcentral banks?\b/i],
];

const INDIRECT_PREDICTION_SIGNALS: ReadonlyArray<[string, RegExp]> = [
  ['recession/financial stress', /\b(?:recession|depression|banking crisis|financial crisis|default|debt ceiling)\b/i],
  ['geopolitical conflict', /\b(?:war|conflict|invasion|strike|attack|ceasefire|nuclear|military)\b/i],
  ['sanctions/trade', /\b(?:sanctions?|tariffs?|trade war|embargo)\b/i],
  ['energy', /\b(?:oil|crude|brent|wti|opec)\b/i],
  ['major hotspot', /\b(?:iran|israel|gaza|russia|ukraine|china|taiwan|north korea|middle east)\b/i],
];

const BROAD_INDEX_SYMBOLS = new Set([
  '^GSPC',
  '^DJI',
  '^IXIC',
  '^HSI',
  '^NSEI',
  '^BSESN',
  '000001.SS',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown, maxItems = 20): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function finiteNumberArray(value: unknown, maxItems = 60): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(finiteNumber)
    .filter((item): item is number => item != null)
    .slice(-maxItems);
}

function timestampMs(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric != null) {
    if (numeric <= 0) return null;
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isoTimestamp(value: unknown): string | null {
  const parsed = timestampMs(value);
  if (parsed == null) return null;
  try {
    return new Date(parsed).toISOString();
  } catch {
    return null;
  }
}

function latestIso(values: Array<string | null>): string | null {
  let latest: string | null = null;
  let latestMs = -Infinity;
  for (const value of values) {
    if (!value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > latestMs) {
      latest = value;
      latestMs = parsed;
    }
  }
  return latest;
}

function readArray(raw: Record<string, unknown> | null, key: string): unknown[] {
  const value = raw?.[key];
  return Array.isArray(value) ? value : [];
}

function observationMonth(date: string): string | null {
  const match = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(date.trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}`;
}

function priorYearMonth(month: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  return `${Number(match[1]) - 1}-${match[2]}`;
}

/**
 * Calculate CPI year-over-year against the observation from the same calendar
 * month one year earlier. Missing months return null instead of silently using
 * an 11- or 13-month comparison.
 */
export function calculateCpiYoY(
  observations: readonly GoldAnalystCpiObservation[],
): GoldAnalystCpiYoY | null {
  const valid = observations
    .map((observation) => ({
      date: stringValue(observation?.date),
      month: observationMonth(stringValue(observation?.date)),
      value: finiteNumber(observation?.value),
    }))
    .filter((observation): observation is { date: string; month: string; value: number } => (
      observation.month != null
      && observation.value != null
      && observation.value > 0
    ))
    .sort((a, b) => a.date.localeCompare(b.date));

  const current = valid[valid.length - 1];
  if (!current) return null;
  const baselineMonth = priorYearMonth(current.month);
  if (!baselineMonth) return null;
  const prior = [...valid].reverse().find((observation) => observation.month === baselineMonth);
  if (!prior) return null;

  return {
    currentDate: current.date,
    currentValue: current.value,
    priorDate: prior.date,
    priorValue: prior.value,
    yoyPct: ((current.value - prior.value) / prior.value) * 100,
  };
}

/**
 * Hyperliquid spark OI is newest-at-tail and sampled every five minutes by the
 * repository seeder. A true one-hour change therefore needs 13 points: current
 * plus the point 12 intervals earlier.
 */
export function calculateHyperliquidOiDelta1h(
  sparkOi: readonly unknown[],
  sampleIntervalMinutes = HYPERLIQUID_SAMPLE_INTERVAL_MINUTES,
): GoldAnalystOiDelta | null {
  if (!Number.isFinite(sampleIntervalMinutes) || sampleIntervalMinutes <= 0) return null;
  const intervals = Math.round(ONE_HOUR_MINUTES / sampleIntervalMinutes);
  if (intervals <= 0 || Math.abs((intervals * sampleIntervalMinutes) - ONE_HOUR_MINUTES) > 0.001) {
    return null;
  }
  if (sparkOi.length <= intervals) return null;

  const current = finiteNumber(sparkOi[sparkOi.length - 1]);
  const oneHourAgo = finiteNumber(sparkOi[sparkOi.length - 1 - intervals]);
  if (current == null || oneHourAgo == null || oneHourAgo <= 0) return null;

  const absolute = current - oneHourAgo;
  return {
    current,
    oneHourAgo,
    absolute,
    pct: (absolute / oneHourAgo) * 100,
    sampleIntervalMinutes,
    intervals,
  };
}

export function filterRelevantPredictionMarkets(
  markets: readonly GoldAnalystPredictionMarketInput[],
  options: { limit?: number; nowMs?: number } = {},
): GoldAnalystRelevantPredictionMarket[] {
  const limit = Math.max(0, Math.min(50, Math.trunc(options.limit ?? 15)));
  const nowMs = options.nowMs ?? Date.now();
  const deduped = new Map<string, GoldAnalystRelevantPredictionMarket>();

  for (const market of markets) {
    const title = stringValue(market.title);
    if (!title) continue;
    const endDateText = stringValue(market.endDate);
    const endDateMs = timestampMs(endDateText);
    if (endDateMs != null && endDateMs < nowMs) continue;

    const direct = DIRECT_PREDICTION_SIGNALS
      .filter(([, pattern]) => pattern.test(title))
      .map(([label]) => label);
    const indirect = INDIRECT_PREDICTION_SIGNALS
      .filter(([, pattern]) => pattern.test(title))
      .map(([label]) => label);
    if (direct.length === 0 && indirect.length === 0) continue;

    const yesPrice = finiteNumber(market.yesPrice);
    const volume = Math.max(0, finiteNumber(market.volume) ?? 0);
    const relevanceScore = (direct.length * 3) + indirect.length;
    const parsed: GoldAnalystRelevantPredictionMarket = {
      title,
      yesPrice: yesPrice != null && yesPrice >= 0 && yesPrice <= 100 ? yesPrice : null,
      volume,
      url: stringValue(market.url),
      endDate: endDateMs == null ? null : new Date(endDateMs).toISOString(),
      source: stringValue(market.source) || 'unknown',
      relevanceScore,
      relevanceSignals: [...direct, ...indirect],
    };
    const key = parsed.url || title.toLocaleLowerCase('en-US');
    const existing = deduped.get(key);
    if (
      !existing
      || parsed.relevanceScore > existing.relevanceScore
      || (
        parsed.relevanceScore === existing.relevanceScore
        && parsed.volume > existing.volume
      )
    ) {
      deduped.set(key, parsed);
    }
  }

  return [...deduped.values()]
    .sort((a, b) => (
      b.relevanceScore - a.relevanceScore
      || b.volume - a.volume
      || a.title.localeCompare(b.title)
    ))
    .slice(0, limit);
}

function parseConflictEvent(
  raw: GoldAnalystConflictEventInput,
): { event: GoldAnalystConflictEvent; startMs: number } | null {
  const startMs = timestampMs(raw.dateStart);
  if (startMs == null) return null;
  const endMs = timestampMs(raw.dateEnd);
  return {
    startMs,
    event: {
      id: stringValue(raw.id),
      dateStart: new Date(startMs).toISOString(),
      dateEnd: endMs == null ? null : new Date(endMs).toISOString(),
      country: stringValue(raw.country) || 'Unknown',
      sideA: stringValue(raw.sideA),
      sideB: stringValue(raw.sideB),
      deathsBest: Math.max(0, finiteNumber(raw.deathsBest) ?? 0),
      deathsLow: Math.max(0, finiteNumber(raw.deathsLow) ?? 0),
      deathsHigh: Math.max(0, finiteNumber(raw.deathsHigh) ?? 0),
      violenceType: stringValue(raw.violenceType),
      sourceOriginal: stringValue(raw.sourceOriginal),
    },
  };
}

export function aggregateConflictEvents(
  events: readonly GoldAnalystConflictEventInput[],
  options: { nowMs?: number; maxRecentEvents?: number } = {},
): GoldAnalystConflictAggregate {
  const nowMs = options.nowMs ?? Date.now();
  const maxRecentEvents = Math.max(0, Math.min(50, Math.trunc(options.maxRecentEvents ?? 15)));
  const dayMs = 24 * 60 * 60 * 1000;
  const parsed = events
    .map(parseConflictEvent)
    .filter((item): item is { event: GoldAnalystConflictEvent; startMs: number } => (
      item != null && item.startMs <= nowMs
    ))
    .sort((a, b) => b.startMs - a.startMs);

  const within = (item: { startMs: number }, days: number) => (
    item.startMs >= nowMs - (days * dayMs)
  );
  const events24h = parsed.filter((item) => within(item, 1));
  const events7d = parsed.filter((item) => within(item, 7));
  const events30d = parsed.filter((item) => within(item, 30));
  const sumDeaths = (items: Array<{ event: GoldAnalystConflictEvent }>) => (
    items.reduce((sum, item) => sum + item.event.deathsBest, 0)
  );

  const countries = new Map<string, GoldAnalystConflictCountryAggregate>();
  for (const item of events30d) {
    const existing = countries.get(item.event.country) ?? {
      country: item.event.country,
      events30d: 0,
      deathsBest30d: 0,
    };
    existing.events30d += 1;
    existing.deathsBest30d += item.event.deathsBest;
    countries.set(item.event.country, existing);
  }

  return {
    validEventCount: parsed.length,
    events24h: events24h.length,
    events7d: events7d.length,
    events30d: events30d.length,
    deathsBest24h: sumDeaths(events24h),
    deathsBest7d: sumDeaths(events7d),
    deathsBest30d: sumDeaths(events30d),
    latestEventAt: parsed[0]?.event.dateStart ?? null,
    topCountries30d: [...countries.values()]
      .sort((a, b) => (
        b.deathsBest30d - a.deathsBest30d
        || b.events30d - a.events30d
        || a.country.localeCompare(b.country)
      ))
      .slice(0, 10),
    recentEvents: parsed.slice(0, maxRecentEvents).map((item) => item.event),
  };
}

function isLocalDevelopment(): boolean {
  return process.env.NODE_ENV === 'development'
    && !process.env.VERCEL
    && process.env.VERCEL_ENV !== 'production';
}

async function readCache(
  cacheReader: NonNullable<LoadGoldAnalystPanelContextOptions['cacheReader']>,
): Promise<Map<string, unknown>> {
  try {
    return await cacheReader(
      SOURCE_DEFINITIONS.map((source) => source.cacheKey),
      true,
    );
  } catch {
    return new Map();
  }
}

async function fetchPublicBootstrapTiers(
  fetchFn: typeof fetch,
): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled((['fast', 'slow'] as const).map(async (tier) => {
    const response = await fetchFn(`${PUBLIC_BOOTSTRAP_BASE_URL}?tier=${tier}&public=1`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Origin: PUBLIC_BOOTSTRAP_ORIGIN,
        'User-Agent': 'WorldMonitor-GoldAnalyst/1.0 (+https://worldmonitor.app)',
      },
      signal: AbortSignal.timeout(PUBLIC_BOOTSTRAP_TIMEOUT_MS),
    });
    if (!response.ok) return {};
    const payload = asRecord(await response.json());
    return asRecord(payload?.data) ?? {};
  }));

  const merged: Record<string, unknown> = {};
  for (const result of results) {
    if (result.status === 'fulfilled') Object.assign(merged, result.value);
  }
  return merged;
}

async function fetchFredCsvSeries(
  fetchFn: typeof fetch,
  seriesId: 'CPIAUCSL' | 'FEDFUNDS',
): Promise<GoldAnalystFredSeriesInput | null> {
  try {
    const url = new URL('https://fred.stlouisfed.org/graph/fredgraph.csv');
    url.searchParams.set('id', seriesId);
    const response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Accept: 'text/csv',
        'User-Agent': 'WorldMonitor-GoldAnalyst/1.0 (+https://worldmonitor.app)',
      },
      signal: AbortSignal.timeout(PUBLIC_BOOTSTRAP_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const rows = (await response.text()).split(/\r?\n/).slice(1);
    const observations = rows.flatMap((row) => {
      const [date = '', rawValue = ''] = row.split(',');
      const value = finiteNumber(rawValue);
      if (!observationMonth(date) || value == null) return [];
      return [{ date, value }];
    }).slice(-36);
    if (observations.length === 0) return null;
    return {
      seriesId,
      title: seriesId === 'CPIAUCSL'
        ? 'Consumer Price Index for All Urban Consumers: All Items'
        : 'Effective Federal Funds Rate',
      units: seriesId === 'CPIAUCSL' ? 'Index 1982-1984=100' : 'Percent',
      frequency: 'Monthly',
      observations,
      asOf: isoTimestamp(observations[observations.length - 1]?.date),
    };
  } catch {
    return null;
  }
}

function rawTimestamp(id: GoldAnalystPanelSourceId, value: unknown): string | null {
  const raw = asRecord(value);
  if (!raw) return null;
  switch (id) {
    case 'fearGreed':
      return isoTimestamp(raw.timestamp);
    case 'economicStress':
      return isoTimestamp(raw.seededAt);
    case 'hyperliquidFlow':
      return isoTimestamp(raw.fetchedAt) ?? isoTimestamp(raw.ts);
    case 'sanctionsPressure':
      return isoTimestamp(raw.fetchedAt);
    case 'ucdpEvents': {
      const eventTimestamps = readArray(raw, 'events')
        .map((event) => isoTimestamp(asRecord(event)?.dateStart));
      return isoTimestamp(raw.fetchedAt) ?? latestIso(eventTimestamps);
    }
    case 'riskScores': {
      const computed = readArray(raw, 'ciiScores')
        .map((score) => isoTimestamp(asRecord(score)?.computedAt));
      return latestIso(computed);
    }
    case 'predictionMarkets':
      return isoTimestamp(raw.fetchedAt);
    case 'marketQuotes':
      return isoTimestamp(raw.fetchedAt) ?? isoTimestamp(raw.updatedAt);
    case 'cpi':
    case 'fedFunds': {
      const series = asRecord(raw.series) ?? raw;
      const observations = parseFredSeries(series)?.observations ?? [];
      const latest = observations[observations.length - 1];
      return latest ? isoTimestamp(latest.date) : null;
    }
  }
}

function sourceRecordCount(id: GoldAnalystPanelSourceId, value: unknown): number {
  const raw = asRecord(value);
  if (!raw) return 0;
  switch (id) {
    case 'fearGreed':
      return asRecord(raw.composite) ? 1 : 0;
    case 'economicStress':
      return readArray(raw, 'components').length;
    case 'hyperliquidFlow':
      return readArray(raw, 'assets').length;
    case 'sanctionsPressure':
      return Math.max(0, finiteNumber(raw.totalCount) ?? readArray(raw, 'entries').length);
    case 'ucdpEvents':
      return readArray(raw, 'events').length;
    case 'riskScores':
      return readArray(raw, 'ciiScores').length;
    case 'predictionMarkets':
      return ['geopolitical', 'finance', 'tech']
        .reduce((sum, key) => sum + readArray(raw, key).length, 0);
    case 'marketQuotes':
      return readArray(raw, 'quotes').length;
    case 'cpi':
    case 'fedFunds':
      return parseFredSeries(asRecord(raw.series) ?? raw)?.observations.length ?? 0;
  }
}

function hasUsableSource(id: GoldAnalystPanelSourceId, value: unknown): boolean {
  const raw = asRecord(value);
  if (!raw) return false;
  switch (id) {
    case 'fearGreed':
      return finiteNumber(asRecord(raw.composite)?.score) != null;
    case 'economicStress':
      return raw.unavailable !== true && finiteNumber(raw.compositeScore) != null;
    case 'hyperliquidFlow':
      return readArray(raw, 'assets').length > 0;
    case 'sanctionsPressure':
      return sourceRecordCount(id, value) > 0
        || readArray(raw, 'countries').length > 0
        || readArray(raw, 'programs').length > 0;
    case 'ucdpEvents':
    case 'riskScores':
    case 'marketQuotes':
      return sourceRecordCount(id, value) > 0;
    case 'predictionMarkets':
      return sourceRecordCount(id, value) > 0;
    case 'cpi':
    case 'fedFunds':
      return sourceRecordCount(id, value) > 0;
  }
}

function buildFearGreed(value: unknown): GoldAnalystFearGreedInput | null {
  const raw = asRecord(value);
  const composite = asRecord(raw?.composite);
  const score = finiteNumber(composite?.score);
  if (!raw || !composite || score == null) return null;

  const categories = asRecord(raw.categories) ?? {};
  return {
    score,
    label: stringValue(composite.label),
    previousScore: finiteNumber(composite.previous),
    categories: Object.entries(categories).flatMap(([id, categoryValue]) => {
      const category = asRecord(categoryValue);
      if (!category) return [];
      return [{
        id,
        score: finiteNumber(category.score),
        weight: finiteNumber(category.weight),
        contribution: finiteNumber(category.contribution),
        degraded: category.degraded === true,
        inputs: asRecord(category.inputs) ?? {},
      }];
    }),
    headerMetrics: Object.fromEntries(
      Object.entries(asRecord(raw.headerMetrics) ?? {})
        .map(([key, metric]) => [key, asRecord(metric)]),
    ),
    asOf: isoTimestamp(raw.timestamp),
  };
}

function buildEconomicStress(value: unknown): GoldAnalystEconomicStressInput | null {
  const raw = asRecord(value);
  const compositeScore = finiteNumber(raw?.compositeScore);
  if (!raw || raw.unavailable === true || compositeScore == null) return null;

  return {
    compositeScore,
    label: stringValue(raw.label),
    components: readArray(raw, 'components').flatMap((value) => {
      const component = asRecord(value);
      if (!component) return [];
      const rawValue = finiteNumber(component.rawValue);
      return [{
        id: stringValue(component.id),
        label: stringValue(component.label),
        rawValue,
        score: finiteNumber(component.score),
        weight: finiteNumber(component.weight),
        missing: component.missing === true || rawValue == null,
      }];
    }),
    asOf: isoTimestamp(raw.seededAt),
  };
}

function isPreciousMetalAsset(raw: Record<string, unknown>): boolean {
  const identity = `${stringValue(raw.symbol)} ${stringValue(raw.display)} ${stringValue(raw.group)}`;
  return /\b(?:gold|silver|paxg|metals?)\b/i.test(identity);
}

function buildHyperliquid(value: unknown): GoldAnalystHyperliquidInput | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const assets = readArray(raw, 'assets').flatMap((value) => {
    const asset = asRecord(value);
    if (!asset || !isPreciousMetalAsset(asset)) return [];
    const sparkOi = Array.isArray(asset.sparkOi) ? asset.sparkOi : [];
    return [{
      symbol: stringValue(asset.symbol),
      display: stringValue(asset.display),
      assetClass: stringValue(asset.class),
      group: stringValue(asset.group),
      funding: finiteNumber(asset.funding),
      openInterest: finiteNumber(asset.openInterest),
      markPrice: finiteNumber(asset.markPx),
      oraclePrice: finiteNumber(asset.oraclePx),
      dayNotional: finiteNumber(asset.dayNotional),
      fundingScore: finiteNumber(asset.fundingScore),
      volumeScore: finiteNumber(asset.volumeScore),
      oiScore: finiteNumber(asset.oiScore),
      basisScore: finiteNumber(asset.basisScore),
      composite: finiteNumber(asset.composite),
      oiDelta1h: calculateHyperliquidOiDelta1h(sparkOi),
      sparkFunding: finiteNumberArray(asset.sparkFunding),
      sparkOi: finiteNumberArray(sparkOi),
      sparkScore: finiteNumberArray(asset.sparkScore),
      warmup: asset.warmup === true,
      stale: asset.stale === true,
      alerts: stringArray(asset.alerts, 10),
    }];
  });
  if (assets.length === 0) return null;
  return {
    assets,
    warmup: raw.warmup === true,
    asOf: isoTimestamp(raw.fetchedAt) ?? isoTimestamp(raw.ts),
  };
}

function buildSanctions(value: unknown): GoldAnalystSanctionsInput | null {
  const raw = asRecord(value);
  if (!raw || !hasUsableSource('sanctionsPressure', value)) return null;

  const countries = readArray(raw, 'countries').flatMap((value) => {
    const country = asRecord(value);
    if (!country) return [];
    return [{
      countryCode: stringValue(country.countryCode),
      countryName: stringValue(country.countryName),
      entryCount: Math.max(0, finiteNumber(country.entryCount) ?? 0),
      newEntryCount: Math.max(0, finiteNumber(country.newEntryCount) ?? 0),
      vesselCount: Math.max(0, finiteNumber(country.vesselCount) ?? 0),
      aircraftCount: Math.max(0, finiteNumber(country.aircraftCount) ?? 0),
    }];
  });
  const programs = readArray(raw, 'programs').flatMap((value) => {
    const program = asRecord(value);
    if (!program) return [];
    return [{
      program: stringValue(program.program),
      entryCount: Math.max(0, finiteNumber(program.entryCount) ?? 0),
      newEntryCount: Math.max(0, finiteNumber(program.newEntryCount) ?? 0),
    }];
  });
  const recentEntries = readArray(raw, 'entries').flatMap((value) => {
    const entry = asRecord(value);
    if (!entry) return [];
    return [{
      id: stringValue(entry.id),
      name: stringValue(entry.name),
      entityType: stringValue(entry.entityType),
      countryCodes: stringArray(entry.countryCodes, 10),
      countryNames: stringArray(entry.countryNames, 10),
      programs: stringArray(entry.programs, 10),
      effectiveAt: isoTimestamp(entry.effectiveAt),
      isNew: entry.isNew === true,
    }];
  });

  return {
    totalCount: Math.max(0, finiteNumber(raw.totalCount) ?? 0),
    newEntryCount: Math.max(0, finiteNumber(raw.newEntryCount) ?? 0),
    vesselCount: Math.max(0, finiteNumber(raw.vesselCount) ?? 0),
    aircraftCount: Math.max(0, finiteNumber(raw.aircraftCount) ?? 0),
    datasetDate: isoTimestamp(raw.datasetDate),
    countries: countries.slice(0, 12),
    programs: programs.slice(0, 12),
    recentEntries: recentEntries.slice(0, 20),
    asOf: isoTimestamp(raw.fetchedAt),
  };
}

function buildRisks(value: unknown): GoldAnalystRiskInput | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const countries = readArray(raw, 'ciiScores').flatMap((value) => {
    const score = asRecord(value);
    const combinedScore = finiteNumber(score?.combinedScore);
    if (!score || combinedScore == null) return [];
    return [{
      region: stringValue(score.region),
      combinedScore,
      dynamicScore: finiteNumber(score.dynamicScore),
      trend: stringValue(score.trend),
      advisoryLevel: stringValue(score.advisoryLevel),
      eventMultiplier: finiteNumber(score.eventMultiplier),
      computedAt: isoTimestamp(score.computedAt),
    }];
  });
  if (countries.length === 0) return null;

  const strategicRisks = readArray(raw, 'strategicRisks').flatMap((value) => {
    const risk = asRecord(value);
    const score = finiteNumber(risk?.score);
    if (!risk || score == null) return [];
    return [{
      region: stringValue(risk.region),
      level: stringValue(risk.level),
      score,
      factors: stringArray(risk.factors, 10),
      trend: stringValue(risk.trend),
    }];
  });

  return {
    degraded: raw.degraded === true,
    stale: raw.stale === true,
    topCountryRisks: countries
      .sort((a, b) => b.combinedScore - a.combinedScore || a.region.localeCompare(b.region))
      .slice(0, 15),
    strategicRisks: strategicRisks
      .sort((a, b) => b.score - a.score || a.region.localeCompare(b.region))
      .slice(0, 12),
    asOf: latestIso(countries.map((country) => country.computedAt)),
  };
}

function predictionCandidates(value: unknown): GoldAnalystPredictionMarketInput[] {
  const raw = asRecord(value);
  if (!raw) return [];
  const candidates = [
    ...readArray(raw, 'finance'),
    ...readArray(raw, 'geopolitical'),
  ];
  return candidates.filter(
    (candidate): candidate is GoldAnalystPredictionMarketInput => asRecord(candidate) != null,
  );
}

function parseMarketQuote(value: unknown): GoldAnalystMarketQuote | null {
  const raw = asRecord(value);
  const price = finiteNumber(raw?.price);
  if (!raw || price == null) return null;
  return {
    symbol: stringValue(raw.symbol),
    name: stringValue(raw.name),
    display: stringValue(raw.display),
    price,
    changePct: finiteNumber(raw.change),
    sparkline: finiteNumberArray(raw.sparkline, 24),
  };
}

function buildMarkets(value: unknown): GoldAnalystMarketInput | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const quotes = readArray(raw, 'quotes')
    .map(parseMarketQuote)
    .filter((quote): quote is GoldAnalystMarketQuote => quote != null);
  if (quotes.length === 0) return null;

  const changes = quotes
    .map((quote) => quote.changePct)
    .filter((change): change is number => change != null);
  const sortedByChange = quotes
    .filter((quote): quote is GoldAnalystMarketQuote & { changePct: number } => quote.changePct != null)
    .sort((a, b) => b.changePct - a.changePct);

  return {
    breadth: {
      quoteCount: quotes.length,
      advancing: changes.filter((change) => change > 0).length,
      declining: changes.filter((change) => change < 0).length,
      unchanged: changes.filter((change) => change === 0).length,
      averageChangePct: changes.length > 0
        ? changes.reduce((sum, change) => sum + change, 0) / changes.length
        : null,
    },
    broadIndices: quotes.filter((quote) => BROAD_INDEX_SYMBOLS.has(quote.symbol)),
    leaders: sortedByChange.slice(0, 5),
    laggards: sortedByChange.slice(-5).reverse(),
  };
}

function parseFredSeries(value: unknown): GoldAnalystFredSeriesInput | null {
  const raw = asRecord(value) as RawFredSeries | null;
  if (!raw || !Array.isArray(raw.observations)) return null;
  const observations = raw.observations.flatMap((value) => {
    const observation = asRecord(value);
    const date = stringValue(observation?.date);
    const number = finiteNumber(observation?.value);
    if (!date || observationMonth(date) == null || number == null) return [];
    return [{ date, value: number }];
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (observations.length === 0) return null;

  return {
    seriesId: stringValue(raw.seriesId),
    title: stringValue(raw.title),
    units: stringValue(raw.units),
    frequency: stringValue(raw.frequency),
    observations: observations.slice(-36),
    asOf: isoTimestamp(observations[observations.length - 1]?.date),
  };
}

function buildSourceAvailability(
  parsedSources: Record<GoldAnalystPanelSourceId, ParsedSource>,
): GoldAnalystPanelSourceAvailabilityMap {
  return Object.fromEntries(SOURCE_DEFINITIONS.map((source) => {
    const parsed = parsedSources[source.id];
    const available = hasUsableSource(source.id, parsed.raw);
    const asOf = available ? rawTimestamp(source.id, parsed.raw) : null;
    let note: string | undefined;
    if (!available) note = 'No usable system cache or bootstrap payload.';
    else if (!asOf) note = 'Source payload is usable but does not publish an as-of timestamp.';
    return [source.id, {
      available,
      cacheKey: source.cacheKey,
      provenance: available ? parsed.provenance : 'unavailable',
      asOf,
      recordCount: available ? sourceRecordCount(source.id, parsed.raw) : 0,
      ...(note ? { note } : {}),
    }];
  })) as GoldAnalystPanelSourceAvailabilityMap;
}

export async function loadGoldAnalystPanelContext(
  options: LoadGoldAnalystPanelContextOptions = {},
): Promise<GoldAnalystPanelContext> {
  const cacheReader = options.cacheReader ?? getCachedJsonBatch;
  const fetchFn = options.fetchFn ?? ((...args) => globalThis.fetch(...args));
  const now = options.now ?? Date.now;
  const assembledAt = new Date(now()).toISOString();
  const cached = await readCache(cacheReader);

  const parsedSources = Object.fromEntries(SOURCE_DEFINITIONS.map((source) => [
    source.id,
    {
      raw: cached.get(source.cacheKey),
      provenance: cached.has(source.cacheKey) ? 'cache' : 'unavailable',
    },
  ])) as Record<GoldAnalystPanelSourceId, ParsedSource>;

  const bootstrapSources = SOURCE_DEFINITIONS.filter((source) => source.bootstrapName);
  const hasBootstrapMiss = bootstrapSources.some(
    (source) => parsedSources[source.id].raw == null,
  );
  const shouldUseLocalFallback = options.isLocalDev ?? isLocalDevelopment();
  let usedLocalBootstrapFallback = false;

  if (shouldUseLocalFallback && hasBootstrapMiss) {
    const bootstrap = await fetchPublicBootstrapTiers(fetchFn);
    for (const source of bootstrapSources) {
      if (
        parsedSources[source.id].raw == null
        && source.bootstrapName
        && bootstrap[source.bootstrapName] != null
      ) {
        parsedSources[source.id] = {
          raw: bootstrap[source.bootstrapName],
          provenance: 'worldmonitor-bootstrap',
        };
        usedLocalBootstrapFallback = true;
      }
    }
  }

  // The production application reads these two series from the seeded FRED
  // cache. A local checkout has no Redis by default, so use the same official
  // structured source as a development-only fallback. This is a fixed series
  // adapter, not web/news search, and never runs when the system cache exists.
  if (shouldUseLocalFallback) {
    const fredRequests: Array<Promise<{
      id: 'cpi' | 'fedFunds';
      value: GoldAnalystFredSeriesInput | null;
    }>> = [];
    if (parsedSources.cpi.raw == null) {
      fredRequests.push(fetchFredCsvSeries(fetchFn, 'CPIAUCSL')
        .then((value) => ({ id: 'cpi', value })));
    }
    if (parsedSources.fedFunds.raw == null) {
      fredRequests.push(fetchFredCsvSeries(fetchFn, 'FEDFUNDS')
        .then((value) => ({ id: 'fedFunds', value })));
    }
    const fredResults = await Promise.all(fredRequests);
    for (const result of fredResults) {
      if (result.value) {
        parsedSources[result.id] = {
          raw: result.value,
          provenance: 'official-source',
        };
      }
    }
  }

  const sourceAvailability = buildSourceAvailability(parsedSources);
  const cpiPayload = asRecord(parsedSources.cpi.raw);
  const fedFundsPayload = asRecord(parsedSources.fedFunds.raw);
  const cpi = parseFredSeries(asRecord(cpiPayload?.series) ?? cpiPayload);
  const fedFunds = parseFredSeries(asRecord(fedFundsPayload?.series) ?? fedFundsPayload);
  const predictionMarkets = filterRelevantPredictionMarkets(
    predictionCandidates(parsedSources.predictionMarkets.raw),
    { nowMs: now() },
  );
  const conflictRaw = asRecord(parsedSources.ucdpEvents.raw);
  const conflictEvents = readArray(conflictRaw, 'events').filter(
    (event): event is GoldAnalystConflictEventInput => asRecord(event) != null,
  );
  const conflicts = sourceAvailability.ucdpEvents.available
    ? aggregateConflictEvents(conflictEvents, { nowMs: now() })
    : null;

  const sourceAsOf = Object.values(sourceAvailability).map((source) => source.asOf);
  return {
    assembledAt,
    asOf: latestIso(sourceAsOf) ?? assembledAt,
    usedLocalBootstrapFallback,
    sourceAvailability,
    fearGreed: buildFearGreed(parsedSources.fearGreed.raw),
    economicStress: buildEconomicStress(parsedSources.economicStress.raw),
    hyperliquidMetals: buildHyperliquid(parsedSources.hyperliquidFlow.raw),
    sanctions: buildSanctions(parsedSources.sanctionsPressure.raw),
    conflicts,
    risks: buildRisks(parsedSources.riskScores.raw),
    predictionMarkets,
    markets: buildMarkets(parsedSources.marketQuotes.raw),
    macro: {
      cpi,
      cpiYoY: calculateCpiYoY(cpi?.observations ?? []),
      fedFunds,
      latestFedFundsRate: fedFunds?.observations[
        (fedFunds?.observations.length ?? 0) - 1
      ]?.value ?? null,
    },
  };
}
