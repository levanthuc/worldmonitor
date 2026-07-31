import { CHROME_UA, yahooGate } from '../../../_shared/constants';
import { getCachedJson } from '../../../_shared/redis';
import { sanitizeForPrompt } from '../../../_shared/llm-sanitize.js';
import {
  assessGoldAnalystReadiness,
  type GoldAnalystReadiness,
} from './gold-analyst-quality';
import {
  loadGoldAnalystPanelContext,
  type GoldAnalystPanelContext,
} from './gold-analyst-panel-context';

const QUOTE_CACHE_MS = 90_000;
const NEWS_CACHE_MS = 5 * 60_000;
const OFFICIAL_DATA_CACHE_MS = 10 * 60_000;
const MAX_NEWS_ITEMS = 5;
const MAX_NEWS_PER_TOPIC = 1;
// Yahoo currently rate-limits the repo-wide full Chrome UA on this local
// egress while accepting the same chart request with its minimal browser UA.
// Keep this endpoint-specific value explicit; every request still identifies
// itself and remains covered by the global Yahoo request gate.
const YAHOO_CHART_UA = 'Mozilla/5.0';

interface YahooChartResult {
  meta?: {
    symbol?: string;
    shortName?: string;
    exchangeName?: string;
    instrumentType?: string;
    currency?: string;
    regularMarketPrice?: number;
    regularMarketTime?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    regularMarketDayHigh?: number;
    regularMarketDayLow?: number;
  };
  timestamp?: number[];
  indicators?: {
    quote?: Array<{ close?: Array<number | null> }>;
  };
}

interface CachedQuote {
  symbol?: string;
  price?: number | null;
  change?: number | null;
  updatedAt?: string;
}

interface DigestItem {
  title?: string;
  source?: string;
  link?: string;
  publishedAt?: number;
}

interface GoldExtendedPayload {
  updatedAt?: string;
  gold?: {
    returns?: { w1?: number; m1?: number; ytd?: number; y1?: number };
    range52w?: { hi?: number; lo?: number; positionPct?: number };
  };
  silver?: {
    returns?: { w1?: number; m1?: number; ytd?: number; y1?: number };
    range52w?: { hi?: number; lo?: number; positionPct?: number };
  };
  drivers?: Array<{
    symbol?: string;
    label?: string;
    value?: number;
    changePct?: number;
    correlation30d?: number;
  }>;
}

interface CotPayload {
  reportDate?: string;
  instruments?: Array<{
    code?: string;
    reportDate?: string;
    managedMoney?: {
      netPct?: number;
      oiSharePct?: number;
      wowNetDelta?: number;
      longPositions?: number;
      shortPositions?: number;
    };
    producerSwap?: {
      netPct?: number;
      oiSharePct?: number;
      wowNetDelta?: number;
      longPositions?: number;
      shortPositions?: number;
    };
    openInterest?: number;
  }>;
}

interface GoldEtfFlowsPayload {
  updatedAt?: string;
  asOfDate?: string;
  tonnes?: number;
  changeW1Tonnes?: number;
  changeM1Tonnes?: number;
  changeW1Pct?: number;
  changeM1Pct?: number;
  changeY1Tonnes?: number;
  changeY1Pct?: number;
  aumUsd?: number;
  nav?: number;
}

interface SpdrLiveSnapshot {
  holdings: GoldEtfFlowsPayload | null;
  spotMidUsd: number | null;
  spotAsOf: string;
  checked: boolean;
}

interface GoldCbReservesPayload {
  updatedAt?: string;
  asOfMonth?: string;
  totalTonnes?: number;
  topBuyers12m?: Array<{ name?: string; deltaTonnes12m?: number }>;
  topSellers12m?: Array<{ name?: string; deltaTonnes12m?: number }>;
}

interface EconomicCalendarPayload {
  events?: Array<{
    event?: string;
    country?: string;
    date?: string;
    impact?: string;
    actual?: string;
    estimate?: string;
    previous?: string;
    unit?: string;
  }>;
  fromDate?: string;
  toDate?: string;
}

interface OfficialYieldSnapshot {
  asOf: string;
  nominal2y: number | null;
  nominal10y: number | null;
  real10y: number | null;
  sourceChecked: boolean;
}

interface CalendarEvent {
  event: string;
  country: string;
  eventAt: string;
  impact: string;
  source: 'BEA' | 'WorldMonitor calendar';
  actual?: string;
  estimate?: string;
  previous?: string;
  unit?: string;
}

interface CalendarSnapshot {
  events: CalendarEvent[];
  checked: boolean;
  asOf: string;
}

export interface GoldAnalystCitation {
  id: string;
  label: string;
  url?: string;
  asOf: string;
  kind: 'market' | 'macro' | 'calendar' | 'positioning' | 'flow' | 'technical' | 'sentiment' | 'geopolitical' | 'news';
}

export interface GoldAnalystObservation {
  id: string;
  category: 'precious' | 'usd-rates' | 'inflation' | 'calendar' | 'positioning' | 'flow' | 'cross-market' | 'technical' | 'sentiment' | 'stress' | 'geopolitical' | 'news';
  label: string;
  value: string;
  source: string;
  asOf: string;
  baseline?: string;
  freshness: 'live' | 'recent' | 'stale';
}

export interface GoldAnalystCoverageItem {
  id: string;
  label: string;
  status: 'available' | 'partial' | 'unavailable';
  observationIds: string[];
  note: string;
}

export interface GoldAnalystContext {
  timestamp: string;
  promptContext: string;
  citations: GoldAnalystCitation[];
  observations: GoldAnalystObservation[];
  activeSources: string[];
  coverage: GoldAnalystCoverageItem[];
  degraded: boolean;
  hasGoldData: boolean;
  readiness: GoldAnalystReadiness;
}

interface LiveQuote {
  symbol: string;
  label: string;
  instrumentName: string;
  exchangeName: string;
  unit: string;
  price: number;
  previousClose: number | null;
  value24h: number | null;
  baseline24hAt: string;
  sessionChange: number | null;
  change24h: number | null;
  sessionChangePct: number | null;
  change24hPct: number | null;
  change5dPct: number | null;
  change1hPct: number | null;
  change4hPct: number | null;
  low24h: number | null;
  high24h: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  asOf: string;
}

interface NewsItem {
  title: string;
  source: string;
  url: string;
  asOf: string;
  topic: 'precious' | 'commodity' | 'mining' | 'macro' | 'geopolitical';
}

const SYMBOLS = [
  { symbol: 'GC=F', label: 'COMEX Gold front-month', unit: 'USD/oz' },
  { symbol: 'SI=F', label: 'COMEX Silver front-month', unit: 'USD/oz' },
  { symbol: 'PL=F', label: 'NYMEX Platinum front-month', unit: 'USD/oz' },
  { symbol: 'PA=F', label: 'NYMEX Palladium front-month', unit: 'USD/oz' },
  { symbol: 'DX-Y.NYB', label: 'US Dollar Index (DXY)', unit: 'index' },
  { symbol: '^TNX', label: 'US 10-Year Treasury yield', unit: '%' },
  { symbol: '^VIX', label: 'CBOE Volatility Index (VIX)', unit: 'index' },
  { symbol: 'CL=F', label: 'WTI Crude Oil front-month', unit: 'USD/bbl' },
  { symbol: 'HG=F', label: 'COMEX Copper front-month', unit: 'USD/lb' },
  { symbol: '^GSPC', label: 'S&P 500 broad equity risk proxy', unit: 'index' },
  { symbol: 'GDX', label: 'VanEck Gold Miners ETF', unit: 'USD/share' },
  { symbol: 'SIL', label: 'Global X Silver Miners ETF', unit: 'USD/share' },
  { symbol: 'NEM', label: 'Newmont', unit: 'USD/share' },
  { symbol: 'B', label: 'Barrick Mining', unit: 'USD/share' },
] as const;

let quoteCache: { expiresAt: number; quotes: LiveQuote[] } | null = null;
let newsCache: { expiresAt: number; items: NewsItem[] } | null = null;
let officialYieldCache: { expiresAt: number; value: OfficialYieldSnapshot } | null = null;
let officialCalendarCache: { expiresAt: number; value: CalendarSnapshot } | null = null;
let directCotCache: { expiresAt: number; value: CotPayload | null } | null = null;
let directEtfFlowsCache: { expiresAt: number; value: GoldEtfFlowsPayload | null } | null = null;
let spdrLiveCache: { expiresAt: number; value: SpdrLiveSnapshot } | null = null;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function pctChange(current: number, prior: number | null): number | null {
  if (prior == null || prior <= 0) return null;
  return ((current - prior) / prior) * 100;
}

function formatNumber(value: number, decimals = 2): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatPct(value: number | null): string {
  if (value == null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function yahooQuoteUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
}

export function closestValueAtOrBefore(
  points: Array<{ timestamp: number; close: number }>,
  targetSec: number,
  maxLagSec: number,
): { timestamp: number; close: number } | null {
  let candidate: { timestamp: number; close: number } | null = null;
  for (const point of points) {
    if (point.timestamp > targetSec) break;
    candidate = point;
  }
  if (!candidate || targetSec - candidate.timestamp > maxLagSec) return null;
  return candidate;
}

async function fetchYahooQuote(
  config: (typeof SYMBOLS)[number],
): Promise<LiveQuote | null> {
  try {
    const fetchChart = async (host: 'query1.finance.yahoo.com' | 'query2.finance.yahoo.com') => {
      await yahooGate();
      const url = new URL(`https://${host}/v8/finance/chart/${encodeURIComponent(config.symbol)}`);
      url.searchParams.set('range', '5d');
      url.searchParams.set('interval', '15m');
      url.searchParams.set('includePrePost', 'true');
      return fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': YAHOO_CHART_UA,
        },
        signal: AbortSignal.timeout(8_000),
      });
    };

    let response = await fetchChart('query1.finance.yahoo.com');
    if (!response.ok) response = await fetchChart('query2.finance.yahoo.com');
    if (!response.ok) return null;

    const payload = await response.json() as { chart?: { result?: YahooChartResult[] } };
    const result = payload.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp ?? [];
    const closes = result.indicators?.quote?.[0]?.close ?? [];
    const points = timestamps
      .map((timestamp, index) => ({ timestamp, close: finiteNumber(closes[index]) }))
      .filter((point): point is { timestamp: number; close: number } => point.close != null);
    const lastPoint = points.length > 0 ? points[points.length - 1] : undefined;
    const metaPrice = finiteNumber(result.meta?.regularMarketPrice);
    const price = metaPrice ?? lastPoint?.close ?? null;
    if (price == null || price <= 0) return null;

    const lastTimestamp = finiteNumber(result.meta?.regularMarketTime)
      ?? lastPoint?.timestamp
      ?? Math.floor(Date.now() / 1000);
    // `chartPreviousClose` is the baseline for the requested chart range
    // (five days here), not the prior trading-session close. Prefer
    // `previousClose` so "session" never silently means "since five days ago".
    const previousClose = finiteNumber(result.meta?.previousClose)
      ?? finiteNumber(result.meta?.chartPreviousClose);
    const point1h = closestValueAtOrBefore(points, lastTimestamp - 60 * 60, 45 * 60);
    const point4h = closestValueAtOrBefore(points, lastTimestamp - 4 * 60 * 60, 90 * 60);
    const point24h = closestValueAtOrBefore(points, lastTimestamp - 24 * 60 * 60, 3 * 60 * 60);
    const value24h = point24h?.close ?? null;
    const firstPoint = points[0]?.close ?? null;
    const points24h = points.filter((point) => (
      point.timestamp >= lastTimestamp - 24 * 60 * 60
      && point.timestamp <= lastTimestamp
    ));
    const lows24h = points24h.map((point) => point.close);

    return {
      symbol: config.symbol,
      label: config.label,
      instrumentName: result.meta?.shortName || config.label,
      exchangeName: result.meta?.exchangeName || '',
      unit: config.unit,
      price,
      previousClose,
      value24h,
      baseline24hAt: point24h ? new Date(point24h.timestamp * 1000).toISOString() : '',
      sessionChange: previousClose != null ? price - previousClose : null,
      change24h: value24h != null ? price - value24h : null,
      sessionChangePct: pctChange(price, previousClose),
      change24hPct: pctChange(price, value24h),
      change5dPct: pctChange(price, firstPoint),
      change1hPct: pctChange(price, point1h?.close ?? null),
      change4hPct: pctChange(price, point4h?.close ?? null),
      low24h: lows24h.length ? Math.min(...lows24h) : null,
      high24h: lows24h.length ? Math.max(...lows24h) : null,
      dayHigh: finiteNumber(result.meta?.regularMarketDayHigh),
      dayLow: finiteNumber(result.meta?.regularMarketDayLow),
      asOf: new Date(lastTimestamp * 1000).toISOString(),
    };
  } catch {
    return null;
  }
}

async function readCachedQuotes(): Promise<LiveQuote[]> {
  try {
    const payload = await getCachedJson('market:commodities-bootstrap:v1', true) as {
      quotes?: CachedQuote[];
      updatedAt?: string;
    } | null;
    const quotes = payload?.quotes ?? [];
    const bySymbol = new Map(quotes.map((quote) => [quote.symbol, quote]));
    const asOf = payload?.updatedAt || new Date().toISOString();

    return SYMBOLS.flatMap((config) => {
      const cached = bySymbol.get(config.symbol);
      const price = finiteNumber(cached?.price);
      if (price == null || price <= 0) return [];
      return [{
        symbol: config.symbol,
        label: config.label,
        instrumentName: config.label,
        exchangeName: '',
        unit: config.unit,
        price,
        previousClose: null,
        value24h: null,
        baseline24hAt: '',
        sessionChange: null,
        change24h: null,
        sessionChangePct: finiteNumber(cached?.change),
        change24hPct: null,
        change5dPct: null,
        change1hPct: null,
        change4hPct: null,
        low24h: null,
        high24h: null,
        dayHigh: null,
        dayLow: null,
        asOf: cached?.updatedAt || asOf,
      }];
    });
  } catch {
    return [];
  }
}

async function loadQuotes(): Promise<LiveQuote[]> {
  if (quoteCache && quoteCache.expiresAt > Date.now()) return quoteCache.quotes;

  const [liveResults, cachedResults] = await Promise.all([
    Promise.all(SYMBOLS.map((config) => fetchYahooQuote(config))),
    readCachedQuotes(),
  ]);
  const cachedBySymbol = new Map(cachedResults.map((quote) => [quote.symbol, quote]));
  const quotes = SYMBOLS.flatMap((config) => {
    const live = liveResults.find((quote) => quote?.symbol === config.symbol);
    const quote = live ?? cachedBySymbol.get(config.symbol);
    return quote ? [quote] : [];
  });

  quoteCache = { expiresAt: Date.now() + QUOTE_CACHE_MS, quotes };
  return quotes;
}

function latestTreasuryEntry(xml: string): string {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
  return entries.length ? entries[entries.length - 1]?.[1] ?? '' : '';
}

function treasuryField(entry: string, field: string): number | null {
  const match = entry.match(new RegExp(`<d:${field}[^>]*>([^<]+)<\\/d:${field}>`, 'i'));
  return finiteNumber(match ? Number(match[1]) : null);
}

function treasuryDate(entry: string): string {
  const match = entry.match(/<d:NEW_DATE[^>]*>([^<]+)<\/d:NEW_DATE>/i);
  return match?.[1] ? `${match[1].slice(0, 10)}T00:00:00Z` : '';
}

async function fetchTreasuryCurve(
  curve: 'daily_treasury_yield_curve' | 'daily_treasury_real_yield_curve',
): Promise<{ entry: string; checked: boolean }> {
  const url = new URL('https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml');
  url.searchParams.set('data', curve);
  url.searchParams.set('field_tdr_date_value', String(new Date().getUTCFullYear()));
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/atom+xml, application/xml, text/xml',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { entry: '', checked: false };
    return { entry: latestTreasuryEntry(await response.text()), checked: true };
  } catch {
    return { entry: '', checked: false };
  }
}

async function loadOfficialYields(): Promise<OfficialYieldSnapshot> {
  if (officialYieldCache && officialYieldCache.expiresAt > Date.now()) {
    return officialYieldCache.value;
  }
  const [nominal, real] = await Promise.all([
    fetchTreasuryCurve('daily_treasury_yield_curve'),
    fetchTreasuryCurve('daily_treasury_real_yield_curve'),
  ]);
  const asOf = treasuryDate(nominal.entry) || treasuryDate(real.entry);
  const value: OfficialYieldSnapshot = {
    asOf,
    nominal2y: treasuryField(nominal.entry, 'BC_2YEAR'),
    nominal10y: treasuryField(nominal.entry, 'BC_10YEAR'),
    real10y: treasuryField(real.entry, 'TC_10YEAR'),
    sourceChecked: nominal.checked || real.checked,
  };
  officialYieldCache = { expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS, value };
  return value;
}

function zonedTimeToUtcIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  let candidate = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(candidate))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const renderedAsUtc = Date.UTC(
      parts.year ?? year,
      (parts.month ?? month) - 1,
      parts.day ?? day,
      parts.hour ?? hour,
      parts.minute ?? minute,
    );
    candidate += Date.UTC(year, month - 1, day, hour, minute) - renderedAsUtc;
  }
  return new Date(candidate).toISOString();
}

const MONTH_NUMBER: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
};

async function fetchBeaCalendar(): Promise<CalendarSnapshot> {
  const asOf = new Date().toISOString();
  try {
    const response = await fetch('https://www.bea.gov/news/schedule', {
      headers: {
        Accept: 'text/html',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { events: [], checked: false, asOf };
    const html = await response.text();
    const year = new Date().getUTCFullYear();
    const events: CalendarEvent[] = [];
    for (const match of html.matchAll(
      /<tr[^>]*class="[^"]*scheduled-releases[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi,
    )) {
      const row = match[1] ?? '';
      const dateMatch = row.match(/<div[^>]*class="release-date"[^>]*>\s*([A-Za-z]+)\s+(\d{1,2})\s*<\/div>/i);
      const timeMatch = row.match(/<small[^>]*class="text-muted"[^>]*>\s*(\d{1,2}):(\d{2})\s*([AP]M)\s*<\/small>/i);
      const titleMatch = row.match(/<td[^>]*class="[^"]*release-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
      if (!dateMatch || !titleMatch) continue;
      const month = MONTH_NUMBER[dateMatch[1] ?? ''];
      const day = Number(dateMatch[2]);
      if (!month || !day) continue;
      let hour = Number(timeMatch?.[1] ?? 8);
      const minute = Number(timeMatch?.[2] ?? 30);
      const ampm = timeMatch?.[3]?.toUpperCase() ?? 'AM';
      if (ampm === 'PM' && hour < 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      const title = sanitizeForPrompt(
        decodeXmlText((titleMatch[1] ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' '),
      );
      if (!title) continue;
      events.push({
        event: title.slice(0, 180),
        country: 'US',
        eventAt: zonedTimeToUtcIso(year, month, day, hour, minute, 'America/New_York'),
        impact: /\b(GDP|Personal Income|Trade|PCE)\b/i.test(title) ? 'high' : 'medium',
        source: 'BEA',
      });
    }
    return { events, checked: true, asOf };
  } catch {
    return { events: [], checked: false, asOf };
  }
}

async function readCachedCalendar(): Promise<CalendarSnapshot> {
  const asOf = new Date().toISOString();
  try {
    const payload = await getCachedJson('economic:econ-calendar:v1', true) as EconomicCalendarPayload | null;
    if (!payload) return { events: [], checked: false, asOf };
    const events = (payload.events ?? []).flatMap((event) => {
      const name = sanitizeForPrompt(event.event ?? '');
      const date = event.date?.slice(0, 10) ?? '';
      if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
      const hour = /FOMC/i.test(name) ? 14 : 8;
      const minute = /FOMC/i.test(name) ? 0 : 30;
      return [{
        event: name.slice(0, 180),
        country: event.country || '',
        eventAt: zonedTimeToUtcIso(
          Number(date.slice(0, 4)),
          Number(date.slice(5, 7)),
          Number(date.slice(8, 10)),
          hour,
          minute,
          'America/New_York',
        ),
        impact: event.impact || '',
        source: 'WorldMonitor calendar' as const,
        actual: event.actual || '',
        estimate: event.estimate || '',
        previous: event.previous || '',
        unit: event.unit || '',
      }];
    });
    return {
      events,
      checked: Boolean(payload.fromDate || payload.toDate || Array.isArray(payload.events)),
      asOf,
    };
  } catch {
    return { events: [], checked: false, asOf };
  }
}

async function loadCalendar(): Promise<CalendarSnapshot> {
  if (officialCalendarCache && officialCalendarCache.expiresAt > Date.now()) {
    return officialCalendarCache.value;
  }
  const [bea, cached] = await Promise.all([fetchBeaCalendar(), readCachedCalendar()]);
  const seen = new Set<string>();
  const now = Date.now();
  const events = [...bea.events, ...cached.events]
    .filter((event) => {
      const timestamp = Date.parse(event.eventAt);
      return Number.isFinite(timestamp)
        && timestamp >= now - 2 * 60 * 60_000
        && timestamp <= now + 36 * 60 * 60_000;
    })
    .filter((event) => {
      const key = `${event.event.toLowerCase()}|${event.eventAt.slice(0, 10)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.eventAt.localeCompare(b.eventAt));
  const value = {
    events,
    checked: bea.checked || cached.checked,
    asOf: bea.checked ? bea.asOf : cached.asOf,
  };
  officialCalendarCache = { expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS, value };
  return value;
}

interface CftcRow {
  cftc_contract_market_code?: string;
  report_date_as_yyyy_mm_dd?: string;
  m_money_positions_long_all?: string;
  m_money_positions_short_all?: string;
}

function cftcNumber(value: string | undefined): number {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field.trim());
      field = '';
    } else {
      field += char;
    }
  }
  fields.push(field.trim());
  return fields;
}

export function parseCftcFuturesOnlyText(text: string): CotPayload | null {
  const instruments = [
    { prefix: '"GOLD -', code: 'GC', contract: '088691' },
    { prefix: '"SILVER -', code: 'SI', contract: '084691' },
  ].flatMap((target) => {
    const line = text.split(/\r?\n/).find((row) => row.startsWith(target.prefix));
    if (!line) return [];
    const fields = parseCsvLine(line);
    if (fields[3] !== target.contract) return [];
    // CFTC Disaggregated Futures Only report, zero-based indexes:
    // 13/14 = managed-money long/short; 61/62 = their weekly changes.
    const long = cftcNumber(fields[13]);
    const short = cftcNumber(fields[14]);
    const gross = Math.max(1, long + short);
    return [{
      code: target.code,
      reportDate: fields[2]?.slice(0, 10) || '',
      managedMoney: {
        netPct: ((long - short) / gross) * 100,
        wowNetDelta: cftcNumber(fields[61]) - cftcNumber(fields[62]),
        longPositions: long,
        shortPositions: short,
      },
    }];
  });
  return instruments.length
    ? { reportDate: instruments[0]?.reportDate, instruments }
    : null;
}

async function fetchCftcCurrentText(): Promise<CotPayload | null> {
  try {
    const devSourceOrigin = process.env.WM_GOLD_ANALYST_DEV_SOURCE_ORIGIN?.trim();
    const url = devSourceOrigin
      ? `${devSourceOrigin}/api/gold-analyst-source/cftc`
      : 'https://www.cftc.gov/dea/newcot/f_disagg.txt';
    const response = await fetch(url, {
      headers: {
        Accept: 'text/plain,*/*',
        Referer: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(devSourceOrigin ? 25_000 : 8_000),
    });
    if (!response.ok) return null;
    return parseCftcFuturesOnlyText(await response.text());
  } catch {
    return null;
  }
}

async function fetchDirectCot(): Promise<CotPayload | null> {
  if (directCotCache && directCotCache.expiresAt > Date.now()) return directCotCache.value;
  try {
    const url = new URL('https://publicreporting.cftc.gov/resource/72hh-3qpy.json');
    url.searchParams.set('$limit', '20');
    url.searchParams.set('$order', 'report_date_as_yyyy_mm_dd DESC');
    url.searchParams.set(
      '$where',
      "cftc_contract_market_code IN('088691','084691')",
    );
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`CFTC HTTP ${response.status}`);
    const rows = await response.json() as CftcRow[];
    const instruments = [
      { contract: '088691', code: 'GC' },
      { contract: '084691', code: 'SI' },
    ].flatMap((target) => {
      const matches = rows.filter((row) => row.cftc_contract_market_code === target.contract);
      const current = matches[0];
      if (!current) return [];
      const prior = matches[1];
      const long = cftcNumber(current.m_money_positions_long_all);
      const short = cftcNumber(current.m_money_positions_short_all);
      const priorNet = prior
        ? cftcNumber(prior.m_money_positions_long_all) - cftcNumber(prior.m_money_positions_short_all)
        : long - short;
      const gross = Math.max(1, long + short);
      return [{
        code: target.code,
        reportDate: current.report_date_as_yyyy_mm_dd?.slice(0, 10) ?? '',
        managedMoney: {
          netPct: ((long - short) / gross) * 100,
          wowNetDelta: (long - short) - priorNet,
          longPositions: long,
          shortPositions: short,
        },
      }];
    });
    const value: CotPayload | null = instruments.length
      ? { reportDate: instruments[0]?.reportDate, instruments }
      : null;
    directCotCache = { expiresAt: Date.now() + 6 * 60 * 60_000, value };
    return value;
  } catch {
    const value = await fetchCftcCurrentText();
    directCotCache = {
      expiresAt: Date.now() + (value ? 6 * 60 * 60_000 : OFFICIAL_DATA_CACHE_MS),
      value,
    };
    return value;
  }
}

async function fetchDirectEtfFlows(): Promise<GoldEtfFlowsPayload | null> {
  if (directEtfFlowsCache && directEtfFlowsCache.expiresAt > Date.now()) {
    return directEtfFlowsCache.value;
  }
  const devSourceOrigin = process.env.WM_GOLD_ANALYST_DEV_SOURCE_ORIGIN?.trim();
  if (!devSourceOrigin) return null;
  try {
    const response = await fetch(`${devSourceOrigin}/api/gold-analyst-source/gld-flows`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(35_000),
    });
    if (!response.ok) throw new Error(`SPDR history HTTP ${response.status}`);
    const payload = await response.json() as GoldEtfFlowsPayload;
    const valid = finiteNumber(payload.tonnes) != null
      && Boolean(payload.asOfDate)
      && finiteNumber(payload.changeW1Tonnes) != null
      && finiteNumber(payload.changeM1Tonnes) != null;
    const value = valid ? payload : null;
    directEtfFlowsCache = { expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS, value };
    return value;
  } catch {
    directEtfFlowsCache = {
      expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS,
      value: null,
    };
    return null;
  }
}

function parseSpdrNumber(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const parsed = Number(String(raw).replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSpdrDate(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const timestamp = Date.parse(`${raw.trim()} 00:00:00 UTC`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

async function fetchSpdrLive(): Promise<SpdrLiveSnapshot> {
  if (spdrLiveCache && spdrLiveCache.expiresAt > Date.now()) return spdrLiveCache.value;
  const empty: SpdrLiveSnapshot = {
    holdings: null,
    spotMidUsd: null,
    spotAsOf: '',
    checked: false,
  };
  try {
    const response = await fetch(
      'https://api.spdrgoldshares.com/api/v1/data?product=gld&exchange=NYSE&lang=en',
      {
        headers: {
          Accept: 'application/json',
          Origin: 'https://www.spdrgoldshares.com',
          Referer: 'https://www.spdrgoldshares.com/usa/',
          'User-Agent': CHROME_UA,
        },
        signal: AbortSignal.timeout(8_000),
      },
    );
    if (!response.ok) throw new Error(`SPDR HTTP ${response.status}`);
    const payload = await response.json() as {
      data?: Record<string, { value?: unknown; date?: unknown } | undefined>;
      metadata?: { generatedDate?: string };
    };
    const tonnes = parseSpdrNumber(payload.data?.total_tonnes?.value);
    const holdingsDate = parseSpdrDate(payload.data?.total_tonnes?.date);
    const spotMidUsd = parseSpdrNumber(payload.data?.spot_mid_usd?.value);
    const spotAsOf = parseSpdrDate(payload.data?.spot_mid_usd?.date);
    const value: SpdrLiveSnapshot = {
      holdings: tonnes != null && tonnes > 0
        ? {
          updatedAt: payload.metadata?.generatedDate || holdingsDate,
          asOfDate: holdingsDate,
          tonnes,
        }
        : null,
      spotMidUsd,
      spotAsOf,
      checked: true,
    };
    spdrLiveCache = { expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS, value };
    return value;
  } catch {
    spdrLiveCache = {
      expiresAt: Date.now() + OFFICIAL_DATA_CACHE_MS,
      value: empty,
    };
    return empty;
  }
}

function normalizePublishedAt(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return '';
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function flattenDigest(digest: unknown): DigestItem[] {
  if (!digest || typeof digest !== 'object') return [];
  if (Array.isArray(digest)) return digest as DigestItem[];
  const data = digest as Record<string, unknown>;
  if (Array.isArray(data.items)) return data.items as DigestItem[];
  if (!data.categories || typeof data.categories !== 'object') return [];

  const items: DigestItem[] = [];
  for (const bucket of Object.values(data.categories as Record<string, unknown>)) {
    if (!bucket || typeof bucket !== 'object') continue;
    const bucketItems = (bucket as Record<string, unknown>).items;
    if (Array.isArray(bucketItems)) items.push(...bucketItems as DigestItem[]);
  }
  return items;
}

function newsTopic(title: string): NewsItem['topic'] | null {
  if (/\b(gold|silver|bullion|xau|xag|precious metals?|gld|slv)\b/i.test(title)) return 'precious';
  if (/\b(mine|mining|min(?:er|ers)|newmont|barrick|agnico|gold fields|pan american silver)\b/i.test(title)) return 'mining';
  if (/\b(federal reserve|fed|fomc|central bank|ecb|boj|boe|pboc|treasury yields?|dollar index|dxy|inflation|cpi|pce|interest rates?)\b/i.test(title)) return 'macro';
  if (/\b(war|conflict|ceasefire|sanction|geopolit|military|missile|attack|invasion|nuclear)\b/i.test(title)) return 'geopolitical';
  if (/\b(commodit(?:y|ies)|metals?|copper|platinum|palladium|oil|crude|materials?)\b/i.test(title)) return 'commodity';
  return null;
}

function isLowEvidenceForecastHeadline(title: string): boolean {
  return /\b(price forecast|price prediction|technical analysis|next 30 days|today, tomorrow|cycle low)\b/i.test(title);
}

function isIrrelevantPreciousMetalHomonym(title: string): boolean {
  return /\b(platinum card|credit card|debit card|music|album|concert|restaurant|nightclub)\b/i.test(title);
}

function safeHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function decodeXmlText(raw: string): string {
  return raw
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

async function readDigestNews(variant: 'full' | 'commodity'): Promise<NewsItem[]> {
  try {
    const digest = await getCachedJson(`news:digest:v1:${variant}:en`, true);
    return flattenDigest(digest)
      .filter((item) => typeof item.title === 'string' && newsTopic(item.title) != null)
      .flatMap((item) => {
        const title = sanitizeForPrompt(item.title ?? '');
        const url = safeHttpUrl(item.link ?? '');
        if (!title || !url) return [];
        const topic = newsTopic(title);
        if (!topic) return [];
        return [{
          title: title.slice(0, 240),
          source: (item.source || new URL(url).hostname).slice(0, 80),
          url,
          topic,
          asOf: normalizePublishedAt(item.publishedAt),
        }];
      })
      .slice(0, MAX_NEWS_ITEMS);
  } catch {
    return [];
  }
}

async function loadConfiguredCommodityDigestLocally(): Promise<NewsItem[]> {
  if (
    process.env.NODE_ENV !== 'development'
    || process.env.VERCEL
    || process.env.VERCEL_ENV === 'production'
  ) {
    return [];
  }
  try {
    const { listFeedDigest } = await import('../../news/v1/list-feed-digest');
    const request = new Request('http://127.0.0.1/api/news/v1/list-feed-digest?variant=commodity&lang=en');
    const digest = await listFeedDigest({
      request,
      pathParams: {},
      headers: {},
    }, {
      variant: 'commodity',
      lang: 'en',
    });
    return flattenDigest(digest)
      .filter((item) => typeof item.title === 'string' && newsTopic(item.title) != null)
      .flatMap((item) => {
        const title = sanitizeForPrompt(item.title ?? '');
        const url = safeHttpUrl(item.link ?? '');
        const topic = newsTopic(title);
        if (!title || !url || !topic) return [];
        return [{
          title: title.slice(0, 240),
          source: (item.source || new URL(url).hostname).slice(0, 80),
          url,
          topic,
          asOf: normalizePublishedAt(item.publishedAt),
        }];
      });
  } catch {
    return [];
  }
}

async function loadNews(): Promise<NewsItem[]> {
  if (newsCache && newsCache.expiresAt > Date.now()) return newsCache.items;

  const [fullDigest, commodityDigest] = await Promise.all([
    readDigestNews('full'),
    readDigestNews('commodity'),
  ]);
  const localDigest = fullDigest.length || commodityDigest.length
    ? []
    : await loadConfiguredCommodityDigestLocally();
  const seen = new Set<string>();
  const topicCounts = new Map<NewsItem['topic'], number>();
  const items = [...commodityDigest, ...fullDigest, ...localDigest]
    .filter((item) => !isLowEvidenceForecastHeadline(item.title))
    .filter((item) => !isIrrelevantPreciousMetalHomonym(item.title))
    .filter((item) => freshness(item.asOf, 72 * 60 * 60_000) !== 'stale')
    .filter((item) => {
      const key = item.url.toLowerCase();
      if (seen.has(key)) return false;
      const count = topicCounts.get(item.topic) ?? 0;
      if (count >= MAX_NEWS_PER_TOPIC) return false;
      seen.add(key);
      topicCounts.set(item.topic, count + 1);
      return true;
    })
    .slice(0, MAX_NEWS_ITEMS);

  newsCache = { expiresAt: Date.now() + NEWS_CACHE_MS, items };
  return items;
}

async function loadEnrichments(): Promise<{
  extended: GoldExtendedPayload | null;
  cot: CotPayload | null;
  etfFlows: GoldEtfFlowsPayload | null;
  cbReserves: GoldCbReservesPayload | null;
  spdrLive: SpdrLiveSnapshot;
}> {
  const [
    extended,
    cachedCot,
    directCot,
    cachedEtfFlows,
    directEtfFlows,
    cbReserves,
    spdrLive,
  ] = await Promise.all([
    getCachedJson('market:gold-extended:v1', true).catch(() => null),
    getCachedJson('market:cot:v1', true).catch(() => null),
    fetchDirectCot(),
    getCachedJson('market:gold-etf-flows:v1', true).catch(() => null),
    fetchDirectEtfFlows(),
    getCachedJson('market:gold-cb-reserves:v1', true).catch(() => null),
    fetchSpdrLive(),
  ]);
  return {
    extended: extended as GoldExtendedPayload | null,
    cot: ((cachedCot as CotPayload | null)?.instruments?.length
      ? cachedCot
      : directCot) as CotPayload | null,
    etfFlows: (cachedEtfFlows as GoldEtfFlowsPayload | null)
      ?? directEtfFlows
      ?? spdrLive.holdings,
    cbReserves: cbReserves as GoldCbReservesPayload | null,
    spdrLive,
  };
}

function freshness(
  asOf: string,
  recentMs = 36 * 60 * 60_000,
): GoldAnalystObservation['freshness'] {
  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp)) return 'stale';
  const age = Math.max(0, Date.now() - timestamp);
  if (age <= 2 * 60 * 60_000) return 'live';
  return age <= recentMs ? 'recent' : 'stale';
}

function pushObservation(
  observations: GoldAnalystObservation[],
  observation: Omit<GoldAnalystObservation, 'freshness'> & {
    freshness?: GoldAnalystObservation['freshness'];
    recentMs?: number;
  },
): void {
  observations.push({
    id: observation.id,
    category: observation.category,
    label: observation.label,
    value: observation.value,
    source: observation.source,
    asOf: observation.asOf,
    baseline: observation.baseline,
    freshness: observation.freshness ?? freshness(observation.asOf, observation.recentMs),
  });
}

function buildEnrichmentLines(
  extended: GoldExtendedPayload | null,
  cot: CotPayload | null,
  etfFlows: GoldEtfFlowsPayload | null,
  cbReserves: GoldCbReservesPayload | null,
  citations: GoldAnalystCitation[],
  observations: GoldAnalystObservation[],
): string[] {
  const lines: string[] = [];

  if (extended?.gold?.returns) {
    const id = `D${citations.length + 1}`;
    const returns = extended.gold.returns;
    const range = extended.gold.range52w;
    citations.push({
      id,
      label: 'WorldMonitor gold history (Yahoo Finance seed)',
      url: yahooQuoteUrl('GC=F'),
      asOf: extended.updatedAt || '',
      kind: 'market',
    });
    const value = `1W ${formatPct(finiteNumber(returns.w1))}; `
      + `1M ${formatPct(finiteNumber(returns.m1))}; YTD ${formatPct(finiteNumber(returns.ytd))}; `
      + `1Y ${formatPct(finiteNumber(returns.y1))}`;
    lines.push(`[${id}] Gold returns: ${value}.`);
    pushObservation(observations, {
      id,
      category: 'technical',
      label: 'Gold multi-horizon returns',
      value,
      source: 'Yahoo Finance history seed',
      asOf: extended.updatedAt || '',
    });
    if (range && finiteNumber(range.hi) != null && finiteNumber(range.lo) != null) {
      lines.push(
        `[${id}] 52-week range: ${formatNumber(range.lo ?? 0)}–${formatNumber(range.hi ?? 0)} USD/oz; `
        + `current position ${formatNumber(range.positionPct ?? 0, 1)}% of range.`
      );
    }
  }

  if (extended?.silver?.returns) {
    const id = `D${citations.length + 1}`;
    const returns = extended.silver.returns;
    const range = extended.silver.range52w;
    citations.push({
      id,
      label: 'WorldMonitor silver history (Yahoo Finance seed)',
      url: yahooQuoteUrl('SI=F'),
      asOf: extended.updatedAt || '',
      kind: 'market',
    });
    const value = `1W ${formatPct(finiteNumber(returns.w1))}; `
      + `1M ${formatPct(finiteNumber(returns.m1))}; YTD ${formatPct(finiteNumber(returns.ytd))}; `
      + `1Y ${formatPct(finiteNumber(returns.y1))}`
      + (range && finiteNumber(range.hi) != null && finiteNumber(range.lo) != null
        ? `; 52-week ${formatNumber(range.lo ?? 0)}–${formatNumber(range.hi ?? 0)} USD/oz; `
          + `position ${formatNumber(range.positionPct ?? 0, 1)}%`
        : '');
    lines.push(`[${id}] Silver history: ${value}.`);
    pushObservation(observations, {
      id,
      category: 'technical',
      label: 'Silver multi-horizon returns and range',
      value,
      source: 'Yahoo Finance history seed',
      asOf: extended.updatedAt || '',
    });
  }

  const drivers = (extended?.drivers ?? []).filter((driver) => (
    driver.symbol
    && driver.label
    && finiteNumber(driver.value) != null
    && finiteNumber(driver.changePct) != null
    && finiteNumber(driver.correlation30d) != null
  )).slice(0, 8);
  if (drivers.length) {
    const id = `D${citations.length + 1}`;
    const value = drivers.map((driver) => (
      `${driver.label} (${driver.symbol}) ${formatNumber(driver.value ?? 0)}, `
      + `change ${formatPct(driver.changePct ?? null)}, 30d correlation ${formatNumber(driver.correlation30d ?? 0, 2)}`
    )).join('; ');
    citations.push({
      id,
      label: 'WorldMonitor Gold Intelligence cross-asset drivers',
      asOf: extended?.updatedAt || '',
      kind: 'technical',
    });
    lines.push(`[${id}] Gold Intelligence observed drivers: ${value}. Correlation is descriptive, not causal.`);
    pushObservation(observations, {
      id,
      category: 'cross-market',
      label: 'Gold Intelligence cross-asset drivers',
      value,
      source: 'WorldMonitor / Yahoo Finance history seed',
      asOf: extended?.updatedAt || '',
    });
  }

  for (const cotConfig of [
    { code: 'GC', label: 'Gold' },
    { code: 'SI', label: 'Silver' },
  ] as const) {
    const instrument = cot?.instruments?.find((item) => item.code === cotConfig.code);
    if (!instrument?.managedMoney || finiteNumber(instrument.managedMoney.netPct) == null) continue;
    const id = `D${citations.length + 1}`;
    const asOf = instrument.reportDate || cot?.reportDate || '';
    const producerSwap = instrument.producerSwap;
    const value = `managed-money net ${formatPct(instrument.managedMoney.netPct ?? null)}; `
      + `weekly net-contract delta ${formatNumber(instrument.managedMoney.wowNetDelta ?? 0, 0)}`
      + (finiteNumber(instrument.managedMoney.oiSharePct) != null
        ? `; managed-money OI share ${formatPct(instrument.managedMoney.oiSharePct ?? null)}`
        : '')
      + (producerSwap && finiteNumber(producerSwap.netPct) != null
        ? `; producer/swap net ${formatPct(producerSwap.netPct ?? null)}`
          + `; producer/swap weekly delta ${formatNumber(producerSwap.wowNetDelta ?? 0, 0)}`
        : '')
      + (finiteNumber(instrument.openInterest) != null
        ? `; open interest ${formatNumber(instrument.openInterest ?? 0, 0)} contracts`
        : '');
    citations.push({
      id,
      label: `CFTC Commitments of Traders — ${cotConfig.label}`,
      url: 'https://www.cftc.gov/MarketReports/CommitmentsofTraders/index.htm',
      asOf,
      kind: 'positioning',
    });
    lines.push(`[${id}] CFTC ${cotConfig.label} positioning: ${value}.`);
    pushObservation(observations, {
      id,
      category: 'positioning',
      label: `CFTC ${cotConfig.label} positioning`,
      value,
      source: 'CFTC',
      asOf,
      recentMs: 14 * 24 * 60 * 60_000,
    });
  }

  if (finiteNumber(etfFlows?.tonnes) != null && etfFlows?.asOfDate) {
    const id = `D${citations.length + 1}`;
    const hasFlowDeltas = finiteNumber(etfFlows.changeW1Tonnes) != null
      && finiteNumber(etfFlows.changeM1Tonnes) != null;
    const value = `${formatNumber(etfFlows.tonnes ?? 0)} tonnes held; `
      + (hasFlowDeltas
        ? `1W ${formatNumber(etfFlows.changeW1Tonnes ?? 0)}t (${formatPct(etfFlows.changeW1Pct ?? null)}); `
          + `1M ${formatNumber(etfFlows.changeM1Tonnes ?? 0)}t (${formatPct(etfFlows.changeM1Pct ?? null)})`
          + (finiteNumber(etfFlows.changeY1Tonnes) != null
            ? `; 1Y ${formatNumber(etfFlows.changeY1Tonnes ?? 0)}t (${formatPct(etfFlows.changeY1Pct ?? null)})`
            : '')
        : '1W/1M flow deltas unavailable')
      + (finiteNumber(etfFlows.aumUsd) != null
        ? `; AUM ${formatNumber((etfFlows.aumUsd ?? 0) / 1_000_000_000, 2)} USD bn`
        : '')
      + (finiteNumber(etfFlows.nav) != null
        ? `; NAV ${formatNumber(etfFlows.nav ?? 0)} USD`
        : '');
    citations.push({
      id,
      label: 'SPDR Gold Shares historical holdings',
      url: 'https://www.spdrgoldshares.com/usa/historical-data/',
      asOf: etfFlows.asOfDate,
      kind: 'flow',
    });
    lines.push(`[${id}] GLD ETF holdings${hasFlowDeltas ? ' and flow' : ''}: ${value}.`);
    pushObservation(observations, {
      id,
      category: 'flow',
      label: 'GLD ETF holdings and flows',
      value,
      source: 'SPDR Gold Shares',
      asOf: etfFlows.asOfDate,
      recentMs: 4 * 24 * 60 * 60_000,
    });
  }

  if (finiteNumber(cbReserves?.totalTonnes) != null && cbReserves?.asOfMonth) {
    const id = `D${citations.length + 1}`;
    const topBuyers = (cbReserves.topBuyers12m ?? [])
      .slice(0, 3)
      .map((buyer) => `${buyer.name || 'unknown'} ${formatNumber(buyer.deltaTonnes12m ?? 0, 1)}t`)
      .join(', ');
    const topSellers = (cbReserves.topSellers12m ?? [])
      .slice(0, 3)
      .map((seller) => `${seller.name || 'unknown'} ${formatNumber(seller.deltaTonnes12m ?? 0, 1)}t`)
      .join(', ');
    const value = `reported total ${formatNumber(cbReserves.totalTonnes ?? 0, 1)}t`
      + `${topBuyers ? `; largest 12M buyers: ${topBuyers}` : ''}`
      + `${topSellers ? `; largest 12M sellers: ${topSellers}` : ''}`;
    citations.push({
      id,
      label: 'IMF international reserve assets — monetary gold',
      url: 'https://data.imf.org/',
      asOf: cbReserves.asOfMonth,
      kind: 'flow',
    });
    lines.push(`[${id}] Central-bank gold reserves (${cbReserves.asOfMonth}): ${value}.`);
    pushObservation(observations, {
      id,
      category: 'flow',
      label: 'Central-bank gold reserves',
      value,
      source: 'IMF',
      asOf: cbReserves.asOfMonth,
      freshness: 'recent',
    });
  }

  return lines;
}

interface PanelEvidenceIds {
  inflation: string[];
  policy: string[];
  realtimePositioning: string[];
  sentiment: string[];
  stress: string[];
  sanctions: string[];
  conflicts: string[];
  instability: string[];
  predictions: string[];
}

function buildPanelContextLines(
  panel: GoldAnalystPanelContext,
  citations: GoldAnalystCitation[],
  observations: GoldAnalystObservation[],
): { lines: string[]; evidence: PanelEvidenceIds } {
  const lines: string[] = [];
  const evidence: PanelEvidenceIds = {
    inflation: [],
    policy: [],
    realtimePositioning: [],
    sentiment: [],
    stress: [],
    sanctions: [],
    conflicts: [],
    instability: [],
    predictions: [],
  };
  const add = (
    bucket: keyof PanelEvidenceIds,
    config: {
      label: string;
      value: string;
      source: string;
      url?: string;
      asOf: string;
      kind: GoldAnalystCitation['kind'];
      category: GoldAnalystObservation['category'];
      baseline?: string;
      recentMs?: number;
    },
  ) => {
    const id = `D${citations.length + 1}`;
    citations.push({
      id,
      label: config.label,
      url: config.url,
      asOf: config.asOf,
      kind: config.kind,
    });
    pushObservation(observations, {
      id,
      category: config.category,
      label: config.label,
      value: config.value,
      source: config.source,
      asOf: config.asOf,
      baseline: config.baseline,
      recentMs: config.recentMs,
    });
    evidence[bucket].push(id);
    lines.push(`[${id}] ${config.label}: ${config.value}.`);
  };

  if (panel.macro.cpiYoY && panel.macro.cpi) {
    const cpi = panel.macro.cpiYoY;
    add('inflation', {
      label: 'U.S. CPI year-over-year',
      value: `${formatPct(cpi.yoyPct)} YoY; index ${formatNumber(cpi.currentValue, 3)}`,
      source: 'FRED CPIAUCSL via WorldMonitor',
      url: 'https://fred.stlouisfed.org/series/CPIAUCSL',
      asOf: cpi.currentDate,
      kind: 'macro',
      category: 'inflation',
      baseline: `same-month baseline ${formatNumber(cpi.priorValue, 3)} at ${cpi.priorDate}`,
      recentMs: 70 * 24 * 60 * 60_000,
    });
  }

  if (panel.macro.latestFedFundsRate != null && panel.macro.fedFunds) {
    add('policy', {
      label: 'Effective Federal Funds Rate',
      value: `${formatNumber(panel.macro.latestFedFundsRate, 2)}%`,
      source: 'FRED FEDFUNDS via WorldMonitor',
      url: 'https://fred.stlouisfed.org/series/FEDFUNDS',
      asOf: panel.macro.fedFunds.asOf || '',
      kind: 'macro',
      category: 'usd-rates',
      baseline: 'monthly effective rate; not an inferred future policy path',
      recentMs: 70 * 24 * 60 * 60_000,
    });
  }

  if (panel.hyperliquidMetals) {
    for (const asset of panel.hyperliquidMetals.assets
      .filter((asset) => /\b(?:PAXG|GOLD|SILVER)\b/i.test(asset.symbol))
      .slice(0, 3)) {
      const value = [
        `composite ${formatNumber(asset.composite ?? 0, 1)}/100`,
        asset.funding == null ? '' : `hourly funding ${formatNumber(asset.funding * 100, 3)}%`,
        asset.oiDelta1h == null ? '' : `OI 1h ${formatPct(asset.oiDelta1h.pct)}`,
        asset.openInterest == null ? '' : `open interest ${formatNumber(asset.openInterest, 2)}`,
        asset.dayNotional == null ? '' : `24h notional ${formatNumber(asset.dayNotional, 0)}`,
        asset.warmup ? 'warming up' : '',
        asset.stale ? 'upstream stale' : '',
      ].filter(Boolean).join('; ');
      add('realtimePositioning', {
        label: `24/7 positioning proxy — ${sanitizeForPrompt(asset.display || asset.symbol)}`,
        value: `${value}. Hyperliquid perpetual proxy only; not COMEX, OTC or physical positioning`,
        source: 'WorldMonitor Hyperliquid Flow',
        asOf: panel.hyperliquidMetals.asOf || '',
        kind: 'positioning',
        category: 'positioning',
      });
    }
  }

  if (panel.fearGreed) {
    const categories = panel.fearGreed.categories
      .filter((category) => category.score != null)
      .slice(0, 5)
      .map((category) => `${sanitizeForPrompt(category.id)} ${formatNumber(category.score ?? 0, 1)}`)
      .join(', ');
    add('sentiment', {
      label: 'WorldMonitor Fear & Greed',
      value: `composite ${formatNumber(panel.fearGreed.score, 1)}/100`
        + `${panel.fearGreed.label ? ` (${sanitizeForPrompt(panel.fearGreed.label)})` : ''}`
        + `${panel.fearGreed.previousScore == null ? '' : `; previous ${formatNumber(panel.fearGreed.previousScore, 1)}`}`
        + `${categories ? `; categories ${categories}` : ''}`,
      source: 'WorldMonitor Fear & Greed composite',
      asOf: panel.fearGreed.asOf || '',
      kind: 'sentiment',
      category: 'sentiment',
    });
  }

  if (panel.economicStress) {
    const components = panel.economicStress.components
      .filter((component) => !component.missing && component.rawValue != null)
      .slice(0, 8)
      .map((component) => (
        `${sanitizeForPrompt(component.label || component.id)} raw ${formatNumber(component.rawValue ?? 0, 3)}, `
        + `score ${formatNumber(component.score ?? 0, 1)}`
      ))
      .join('; ');
    add('stress', {
      label: 'WorldMonitor Economic Stress',
      value: `composite ${formatNumber(panel.economicStress.compositeScore, 1)}/100`
        + `${panel.economicStress.label ? ` (${sanitizeForPrompt(panel.economicStress.label)})` : ''}`
        + `${components ? `; components: ${components}` : ''}`,
      source: 'WorldMonitor Economic Stress cache',
      asOf: panel.economicStress.asOf || '',
      kind: 'sentiment',
      category: 'stress',
    });
  }

  if (panel.sanctions) {
    const topCountries = panel.sanctions.countries
      .slice()
      .sort((a, b) => b.newEntryCount - a.newEntryCount || b.entryCount - a.entryCount)
      .slice(0, 3)
      .map((country) => (
        `${sanitizeForPrompt(country.countryName || country.countryCode)} `
        + `${formatNumber(country.entryCount, 0)} total/${formatNumber(country.newEntryCount, 0)} new`
      ))
      .join(', ');
    add('sanctions', {
      label: 'WorldMonitor Sanctions Pressure',
      value: `${formatNumber(panel.sanctions.totalCount, 0)} listed entries; `
        + `${formatNumber(panel.sanctions.newEntryCount, 0)} newly flagged`
        + `${topCountries ? `; leading countries ${topCountries}` : ''}`,
      source: 'WorldMonitor sanctions cache',
      asOf: panel.sanctions.asOf || panel.sanctions.datasetDate || '',
      kind: 'geopolitical',
      category: 'geopolitical',
      baseline: 'total stock is not a directional change; new-entry count is the supplied flow signal',
    });
  }

  if (panel.conflicts) {
    const topCountries = panel.conflicts.topCountries30d
      .slice(0, 6)
      .map((country) => (
        `${sanitizeForPrompt(country.country)} ${country.events30d} events/`
        + `${formatNumber(country.deathsBest30d, 0)} best-estimate deaths`
      ))
      .join(', ');
    add('conflicts', {
      label: 'WorldMonitor armed-conflict events',
      value: `24h ${panel.conflicts.events24h} events; 7d ${panel.conflicts.events7d}; `
        + `30d ${panel.conflicts.events30d}; 30d best-estimate deaths ${formatNumber(panel.conflicts.deathsBest30d, 0)}`
        + `${topCountries ? `; top 30d countries ${topCountries}` : ''}`,
      source: 'UCDP events via WorldMonitor',
      asOf: panel.conflicts.latestEventAt || panel.sourceAvailability.ucdpEvents.asOf || '',
      kind: 'geopolitical',
      category: 'geopolitical',
      baseline: 'event-date windows from the supplied UCDP snapshot; not a live battlefield feed',
      recentMs: 8 * 24 * 60 * 60_000,
    });
  }

  if (panel.risks) {
    const countryRisks = panel.risks.topCountryRisks.slice(0, 5)
      .map((risk) => (
        `${sanitizeForPrompt(risk.region)} ${formatNumber(risk.combinedScore, 1)}`
        + `${risk.trend ? `/${sanitizeForPrompt(risk.trend)}` : ''}`
      ))
      .join(', ');
    add('instability', {
      label: 'WorldMonitor Country Instability Index',
      value: `highest supplied scores ${countryRisks || 'n/a'}`
        + `${panel.risks.degraded ? '; degraded' : ''}${panel.risks.stale ? '; stale' : ''}`,
      source: 'WorldMonitor CII risk cache',
      asOf: panel.risks.asOf || '',
      kind: 'geopolitical',
      category: 'geopolitical',
      baseline: 'composite risk ranking; it does not by itself prove safe-haven demand',
    });
  }

  for (const market of panel.predictionMarkets.slice(0, 2)) {
    add('predictions', {
      label: `Prediction market — ${sanitizeForPrompt(market.title)}`,
      value: market.yesPrice == null
        ? `YES probability unavailable; volume ${formatNumber(market.volume, 0)}`
        : `YES ${formatNumber(market.yesPrice, 1)}%; volume ${formatNumber(market.volume, 0)}`,
      source: `WorldMonitor prediction cache (${sanitizeForPrompt(market.source)})`,
      url: safeHttpUrl(market.url) ?? undefined,
      asOf: panel.sourceAvailability.predictionMarkets.asOf || '',
      kind: 'geopolitical',
      category: 'geopolitical',
      baseline: `market belief, not a fact; relevance signals: ${market.relevanceSignals.map(sanitizeForPrompt).join(', ')}`,
    });
  }

  return { lines, evidence };
}

function buildCoverage(
  observations: GoldAnalystObservation[],
  panelEvidence: PanelEvidenceIds,
): GoldAnalystCoverageItem[] {
  const ids = (
    predicate: (observation: GoldAnalystObservation) => boolean,
  ) => observations.filter(predicate).map((observation) => observation.id);
  const quoteIds = (...symbols: string[]) => ids((observation) => (
    symbols.some((symbol) => observation.label.includes(`(${symbol})`))
  ));
  const newsIds = (...topics: NewsItem['topic'][]) => ids((observation) => (
    observation.category === 'news'
    && topics.some((topic) => observation.value.includes(`Topic ${topic}`))
  ));
  const goldSilver = quoteIds('GC=F', 'SI=F');
  const goldIntelligence = ids((observation) => (
    observation.category === 'technical'
    || observation.label.includes('Gold Intelligence')
  ));
  const cot = ids((observation) => observation.label.startsWith('CFTC '));
  const flows = ids((observation) => (
    observation.category === 'flow'
    && !observation.label.includes('Central-bank')
  ));
  const forex = quoteIds('DX-Y.NYB');
  const yields = ids((observation) => (
    observation.category === 'usd-rates'
    && observation.label.includes('Treasury')
  ));
  const centralBank = [
    ...panelEvidence.policy,
    ...ids((observation) => observation.label.includes('Central-bank')),
    ...ids((observation) => (
      observation.category === 'calendar'
      && /\b(fed|fomc|central bank|ecb|boj|boe|pboc)\b/i.test(observation.label)
    )),
  ];
  const metals = [
    ...quoteIds('SI=F', 'PL=F', 'PA=F', 'HG=F'),
    ...ids((observation) => observation.label.includes('cross-asset drivers')),
  ];
  const miners = quoteIds('GDX', 'SIL', 'NEM', 'B');
  const directNews = newsIds('precious');
  const commodityNews = newsIds('commodity');
  const miningNews = newsIds('mining');
  const geopoliticalIds = [
    ...panelEvidence.conflicts,
    ...panelEvidence.sanctions,
    ...panelEvidence.instability,
  ];
  const item = (
    id: string,
    label: string,
    observationIds: string[],
    status: GoldAnalystCoverageItem['status'],
    note: string,
  ): GoldAnalystCoverageItem => {
    const uniqueIds = [...new Set(observationIds)];
    const allStale = uniqueIds.length > 0 && uniqueIds.every((observationId) => (
      observations.find((observation) => observation.id === observationId)?.freshness === 'stale'
    ));
    return {
      id,
      label,
      status: uniqueIds.length === 0 ? 'unavailable' : allStale ? 'partial' : status,
      observationIds: uniqueIds,
      note: uniqueIds.length === 0
        ? 'Không có quan sát khả dụng trong snapshot hiện tại.'
        : allStale
          ? `${note} Toàn bộ quan sát hiện có đã cũ; không dùng làm tín hiệu hiện tại.`
          : note,
    };
  };

  return [
    item('gold-silver', 'GOLD & SILVER', [...goldSilver, ...directNews], 'available', 'Giá futures và tin tiêu đề từ luồng tin WorldMonitor; futures không phải spot.'),
    item(
      'gold-intelligence',
      'GOLD INTELLIGENCE',
      goldIntelligence,
      goldIntelligence.length >= 2 ? 'available' : 'partial',
      'Có động lượng/khoảng giá; hiệu suất nhiều kỳ và tương quan chỉ có khi cache Gold Intelligence được cấp.',
    ),
    item('positioning-247', '24/7 POSITIONING', panelEvidence.realtimePositioning, 'partial', 'Hyperliquid perpetual proxy; không phải vị thế COMEX, OTC hay vàng vật chất.'),
    item('liquidity-shifts', 'LIQUIDITY SHIFTS', [...cot, ...flows, ...panelEvidence.realtimePositioning], 'partial', 'Kết hợp COT tuần, ETF và proxy OI/funding; hệ thống chưa có thước đo thanh khoản vàng toàn thị trường.'),
    item('cot-positioning', 'COT POSITIONING', cot, 'available', 'Báo cáo CFTC theo tuần, không phải dữ liệu real-time.'),
    item('commodity-news', 'COMMODITY NEWS / COMMODITIES NEWS', commodityNews, 'partial', 'Chỉ cung cấp headline và metadata từ các feed đã cấu hình; không cung cấp toàn văn bài viết.'),
    item('metals-materials', 'METALS & MATERIALS', metals, 'available', 'Bạc, đồng, platinum/palladium và driver liên thị trường khi quote khả dụng.'),
    item('mining-news', 'MINING NEWS', miningNews, 'partial', 'Chỉ headline và metadata từ feed khai khoáng đã cấu hình.'),
    item('mining-companies', 'MINING COMPANIES', [...miners, ...miningNews], 'partial', 'Có giá cổ phiếu/ETF và headline; chưa có báo cáo tài chính đầy đủ để kết luận sức khỏe doanh nghiệp.'),
    item('forex', 'FOREX & CURRENCIES', forex, 'partial', 'Dùng DXY; chưa đại diện toàn bộ bảng tỷ giá.'),
    item('yield-curve', 'FIXED INCOME & YIELD CURVE', yields, 'available', 'Lợi suất danh nghĩa/thực Mỹ từ Treasury và đối chiếu quote khi khả dụng.'),
    item('central-bank', 'CENTRAL BANK WATCH', centralBank, 'partial', 'Fed Funds, lịch sự kiện và dự trữ vàng NHTW; không mặc định bao quát mọi phát biểu chính sách.'),
    item('consumer-prices', 'CONSUMER PRICES / CPI', panelEvidence.inflation, 'available', 'CPI Mỹ YoY tính đúng cùng tháng một năm trước từ chuỗi FRED CPIAUCSL.'),
    item('macro-stress', 'MACRO STRESS & FINANCIAL STRESS', panelEvidence.stress, 'available', 'Composite và thành phần stress đúng theo snapshot WorldMonitor.'),
    item('fear-greed', 'FEAR & GREED', panelEvidence.sentiment, 'available', 'Tâm lý thị trường tổng hợp, không phải sentiment riêng của vàng.'),
    item('global-situation', 'GLOBAL SITUATION', geopoliticalIds, 'partial', 'Dùng các lớp cấu trúc liên quan: xung đột, trừng phạt và CII; không gửi toàn bộ bản đồ vào mô hình.'),
    item('armed-conflict', 'ARMED CONFLICT EVENTS', panelEvidence.conflicts, 'available', 'Cửa sổ sự kiện từ UCDP snapshot; độ mới được ghi rõ.'),
    item('sanctions', 'SANCTIONS PRESSURE', panelEvidence.sanctions, 'available', 'Tổng số là stock; new-entry count mới là tín hiệu thay đổi được cung cấp.'),
    item('instability', 'COUNTRY INSTABILITY', panelEvidence.instability, 'available', 'CII là điểm tổng hợp rủi ro; không được dùng riêng lẻ để suy ra hướng vàng.'),
    item('predictions', 'PREDICTIONS', panelEvidence.predictions, 'partial', 'Chỉ market còn hạn và có liên hệ trực tiếp/gián tiếp với vàng; xác suất là niềm tin thị trường, không phải sự kiện đã xảy ra.'),
  ];
}

export async function assembleGoldAnalystContext(): Promise<GoldAnalystContext> {
  const [quotes, news, enrichments, yields, calendar, panelContext] = await Promise.all([
    loadQuotes(),
    loadNews(),
    loadEnrichments(),
    loadOfficialYields(),
    loadCalendar(),
    loadGoldAnalystPanelContext(),
  ]);
  const citations: GoldAnalystCitation[] = [];
  const observations: GoldAnalystObservation[] = [];
  const dataLines: string[] = [];

  for (const quote of quotes) {
    const id = `D${citations.length + 1}`;
    citations.push({
      id,
      label: `${quote.instrumentName} (${quote.symbol})`,
      url: yahooQuoteUrl(quote.symbol),
      asOf: quote.asOf,
      kind: 'market',
    });
    const fullHorizon = ['GC=F', 'SI=F', 'DX-Y.NYB'].includes(quote.symbol);
    const value = `${formatNumber(quote.price)} ${quote.unit}; `
      + (quote.symbol === '^TNX'
        ? `24h ${quote.change24h == null ? 'n/a' : `${quote.change24h >= 0 ? '+' : ''}${(quote.change24h * 100).toFixed(1)} bp`}; `
        : `${fullHorizon ? `session ${formatPct(quote.sessionChangePct)}; ` : ''}24h ${formatPct(quote.change24hPct)}; `)
      + `${fullHorizon ? `1h ${formatPct(quote.change1hPct)}; 4h ${formatPct(quote.change4hPct)}; ` : ''}`
      + `5d ${formatPct(quote.change5dPct)}`;
    dataLines.push(
      `[${id}] ${quote.instrumentName} (${quote.symbol}${quote.exchangeName ? `, ${quote.exchangeName}` : ''}): ${value}`
      + `${quote.dayLow != null && quote.dayLow > 0 && quote.dayHigh != null && quote.dayHigh > 0
        ? `; session range ${formatNumber(quote.dayLow)}–${formatNumber(quote.dayHigh)}`
        : ''}.`
    );
    pushObservation(observations, {
      id,
      category: quote.symbol === 'GC=F' || quote.symbol === 'SI=F' ? 'precious' : 'cross-market',
      label: `${quote.instrumentName} (${quote.symbol})`,
      value,
      source: 'Yahoo Finance',
      asOf: quote.asOf,
      baseline: quote.baseline24hAt
        ? `24h baseline ${formatNumber(quote.value24h ?? 0)} at ${quote.baseline24hAt}; prior close ${formatNumber(quote.previousClose ?? 0)}`
        : quote.previousClose != null
          ? `prior close ${formatNumber(quote.previousClose)}`
          : '24h baseline unavailable',
    });
  }

  const goldQuote = quotes.find((quote) => quote.symbol === 'GC=F');
  if (goldQuote?.low24h != null && goldQuote.high24h != null) {
    const id = `D${citations.length + 1}`;
    const value = `1h ${formatPct(goldQuote.change1hPct)}; 4h ${formatPct(goldQuote.change4hPct)}; `
      + `24h observed low/high ${formatNumber(goldQuote.low24h)}–${formatNumber(goldQuote.high24h)} USD/oz`;
    citations.push({
      id,
      label: 'Deterministic GC=F 15-minute calculations',
      url: yahooQuoteUrl('GC=F'),
      asOf: goldQuote.asOf,
      kind: 'technical',
    });
    dataLines.push(`[${id}] Mechanical momentum/range (not analyst-drawn support/resistance): ${value}.`);
    pushObservation(observations, {
      id,
      category: 'technical',
      label: 'Gold mechanical momentum/range',
      value,
      source: 'Calculated from Yahoo Finance 15-minute closes',
      asOf: goldQuote.asOf,
    });
  }

  if (yields.nominal10y != null || yields.real10y != null || yields.nominal2y != null) {
    const id = `D${citations.length + 1}`;
    const value = `2Y nominal ${yields.nominal2y == null ? 'n/a' : `${formatNumber(yields.nominal2y, 2)}%`}; `
      + `10Y nominal ${yields.nominal10y == null ? 'n/a' : `${formatNumber(yields.nominal10y, 2)}%`}; `
      + `10Y real ${yields.real10y == null ? 'n/a' : `${formatNumber(yields.real10y, 2)}%`}`;
    citations.push({
      id,
      label: 'U.S. Treasury daily nominal and real yield curves',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates',
      asOf: yields.asOf,
      kind: 'macro',
    });
    dataLines.push(`[${id}] Official U.S. Treasury curve: ${value}.`);
    pushObservation(observations, {
      id,
      category: 'usd-rates',
      label: 'U.S. Treasury nominal and real yields',
      value,
      source: 'U.S. Treasury',
      asOf: yields.asOf,
      recentMs: 4 * 24 * 60 * 60_000,
    });
  }

  if (enrichments.spdrLive.spotMidUsd != null && enrichments.spdrLive.spotAsOf) {
    const id = `D${citations.length + 1}`;
    const value = `${formatNumber(enrichments.spdrLive.spotMidUsd)} USD/oz spot mid reference`;
    citations.push({
      id,
      label: 'SPDR Gold Shares spot gold mid reference',
      url: 'https://www.spdrgoldshares.com/usa/',
      asOf: enrichments.spdrLive.spotAsOf,
      kind: 'market',
    });
    dataLines.push(
      `[${id}] SPDR spot gold reference: ${value}. This is a spot reference and must not be treated as the same instrument as GC=F futures.`,
    );
    pushObservation(observations, {
      id,
      category: 'precious',
      label: 'SPDR spot gold mid reference',
      value,
      source: 'SPDR Gold Shares',
      asOf: enrichments.spdrLive.spotAsOf,
      recentMs: 2 * 24 * 60 * 60_000,
    });
  }

  const calendarLines: string[] = [];
  if (calendar.events.length) {
    for (const event of calendar.events.slice(0, 8)) {
      const id = `D${citations.length + 1}`;
      const details = [
        event.actual ? `actual ${event.actual}${event.unit || ''}` : '',
        event.estimate ? `estimate ${event.estimate}${event.unit || ''}` : '',
        event.previous ? `previous ${event.previous}${event.unit || ''}` : '',
      ].filter(Boolean).join('; ');
      citations.push({
        id,
        label: `${event.source}: ${event.event}`,
        url: event.source === 'BEA'
          ? 'https://www.bea.gov/news/schedule'
          : 'https://fred.stlouisfed.org/releases/calendar',
        asOf: event.eventAt,
        kind: 'calendar',
      });
      const value = `${event.eventAt}; impact ${event.impact || 'unknown'}${details ? `; ${details}` : ''}`;
      calendarLines.push(`[${id}] Upcoming ${event.country} event: ${event.event}; ${value}.`);
      pushObservation(observations, {
        id,
        category: 'calendar',
        label: event.event,
        value,
        source: event.source,
        asOf: event.eventAt,
        freshness: 'recent',
      });
    }
  } else if (calendar.checked) {
    const id = `D${citations.length + 1}`;
    citations.push({
      id,
      label: 'Official/cached economic calendar checked',
      url: 'https://www.bea.gov/news/schedule',
      asOf: calendar.asOf,
      kind: 'calendar',
    });
    calendarLines.push(`[${id}] Economic calendar was checked; no matched high-impact event was found in the next 36 hours.`);
    pushObservation(observations, {
      id,
      category: 'calendar',
      label: 'Economic calendar check',
      value: 'No matched high-impact event in the next 36 hours',
      source: 'BEA / WorldMonitor calendar',
      asOf: calendar.asOf,
    });
  }

  dataLines.push(...buildEnrichmentLines(
    enrichments.extended,
    enrichments.cot,
    enrichments.etfFlows,
    enrichments.cbReserves,
    citations,
    observations,
  ));
  const panelResult = buildPanelContextLines(panelContext, citations, observations);

  const newsLines: string[] = [];
  for (const item of news) {
    const id = `N${newsLines.length + 1}`;
    citations.push({
      id,
      label: `${item.source}: ${item.title}`,
      url: item.url,
      asOf: item.asOf,
      kind: 'news',
    });
    newsLines.push(
      `[${id}] Headline only [${item.topic}]: ${item.title} — ${item.source}${item.asOf ? ` (${item.asOf})` : ''}.`,
    );
    pushObservation(observations, {
      id,
      category: 'news',
      label: item.title,
      value: `Topic ${item.topic}; headline only; article body was not supplied to the model`,
      source: item.source,
      asOf: item.asOf,
      recentMs: 36 * 60 * 60_000,
    });
  }

  const hasGoldData = quotes.some((quote) => quote.symbol === 'GC=F');
  const silverQuote = quotes.find((quote) => quote.symbol === 'SI=F');
  const dxyQuote = quotes.find((quote) => quote.symbol === 'DX-Y.NYB');
  const yahoo10y = quotes.find((quote) => quote.symbol === '^TNX');
  const severeRateConflict = yahoo10y != null
    && yields.nominal10y != null
    && Math.abs(yahoo10y.price - yields.nominal10y) > 0.25;
  const goldCot = enrichments.cot?.instruments?.find((instrument) => instrument.code === 'GC');
  const silverCot = enrichments.cot?.instruments?.find((instrument) => instrument.code === 'SI');
  const isUsable = (id: string) => observations.some(
    (observation) => observation.id === id && observation.freshness !== 'stale',
  );
  const hasUsable = (ids: string[]) => ids.some(isUsable);
  const goldCotIds = observations
    .filter((observation) => observation.label === 'CFTC Gold positioning')
    .map((observation) => observation.id);
  const silverCotIds = observations
    .filter((observation) => observation.label === 'CFTC Silver positioning')
    .map((observation) => observation.id);
  const etfHoldingIds = observations
    .filter((observation) => observation.label === 'GLD ETF holdings and flows')
    .map((observation) => observation.id);
  const hasFreshEtf = hasUsable(etfHoldingIds);
  const hasRealtimePositioning = panelContext.hyperliquidMetals?.assets.some(
    (asset) => !asset.stale && !asset.warmup,
  ) === true && hasUsable(panelResult.evidence.realtimePositioning);
  const hasGeopoliticalRisk = hasUsable([
    ...panelResult.evidence.conflicts,
    ...panelResult.evidence.sanctions,
    ...panelResult.evidence.instability,
  ]);
  const readiness = assessGoldAnalystReadiness({
    hasGold: Boolean(goldQuote),
    hasGold24h: goldQuote?.change24hPct != null,
    hasSilver: Boolean(silverQuote),
    hasSilver24h: silverQuote?.change24hPct != null,
    hasDxy: Boolean(dxyQuote),
    hasNominalRates: yields.nominal10y != null || Boolean(yahoo10y),
    hasRealYield: yields.real10y != null,
    hasPolicyRate: hasUsable(panelResult.evidence.policy),
    hasInflation: hasUsable(panelResult.evidence.inflation),
    calendarChecked: calendar.checked,
    hasGoldCot: goldCot?.managedMoney?.netPct != null && hasUsable(goldCotIds),
    hasSilverCot: silverCot?.managedMoney?.netPct != null && hasUsable(silverCotIds),
    hasRealtimePositioning,
    hasEtfHoldings: enrichments.etfFlows?.tonnes != null && hasFreshEtf,
    hasEtfFlows: finiteNumber(enrichments.etfFlows?.changeW1Tonnes) != null && hasFreshEtf,
    hasGoldTechnical: goldQuote?.low24h != null && goldQuote.high24h != null,
    crossMarketCount: quotes.filter((quote) => !['GC=F', 'SI=F'].includes(quote.symbol)).length,
    hasNews: news.length > 0,
    hasStress: hasUsable(panelResult.evidence.stress),
    hasSentiment: hasUsable(panelResult.evidence.sentiment),
    hasGeopoliticalRisk,
    hasPredictionMarkets: hasUsable(panelResult.evidence.predictions),
    severeRateConflict,
  });
  const coverage = buildCoverage(observations, panelResult.evidence);
  const activeSources = [
    ...(quotes.length ? ['Yahoo Finance'] : []),
    ...(yields.sourceChecked ? ['U.S. Treasury'] : []),
    ...(calendar.checked ? ['Economic calendar'] : []),
    ...(enrichments.extended ? ['Gold history'] : []),
    ...(enrichments.cot ? ['CFTC COT'] : []),
    ...(enrichments.etfFlows ? ['SPDR GLD holdings/flows'] : []),
    ...(enrichments.cbReserves ? ['IMF reserves'] : []),
    ...(news.length ? ['Live news'] : []),
    ...(panelContext.sourceAvailability.fearGreed.available ? ['Fear & Greed'] : []),
    ...(panelContext.sourceAvailability.economicStress.available ? ['Economic Stress'] : []),
    ...(panelContext.sourceAvailability.hyperliquidFlow.available ? ['24/7 Positioning'] : []),
    ...(panelContext.sourceAvailability.sanctionsPressure.available ? ['Sanctions Pressure'] : []),
    ...(panelContext.sourceAvailability.ucdpEvents.available ? ['UCDP conflict events'] : []),
    ...(panelContext.sourceAvailability.riskScores.available ? ['Country Instability Index'] : []),
    ...(panelContext.sourceAvailability.predictionMarkets.available ? ['Prediction markets'] : []),
    ...(panelContext.sourceAvailability.cpi.available ? ['FRED CPI'] : []),
    ...(panelContext.sourceAvailability.fedFunds.available ? ['FRED Fed Funds'] : []),
  ];
  const promptContext = [
    '## DATA READINESS',
    `Score ${readiness.score}/100; level ${readiness.level}; directional prediction allowed: ${readiness.predictionAllowed ? 'YES' : 'NO'}.`,
    `Missing: ${readiness.missing.length ? readiness.missing.join('; ') : 'none'}.`,
    `Warnings: ${readiness.warnings.length ? readiness.warnings.join('; ') : 'none'}.`,
    'Instrument scope: GC=F and SI=F are COMEX front-month futures. They are not spot XAU/USD or XAG/USD. Use the exact contract name supplied by Yahoo and do not relabel a futures quote as spot.',
    '## LIVE MARKET DATA',
    dataLines.length ? dataLines.join('\n') : '(No market observations available.)',
    '## POSITIONING, INFLATION, STRESS & GEOPOLITICAL DATA',
    panelResult.lines.length
      ? panelResult.lines.join('\n')
      : '(No additional WorldMonitor panel observations available.)',
    '## HIGH-IMPACT CALENDAR (NEXT 36H)',
    calendarLines.length ? calendarLines.join('\n') : '(Calendar unavailable; this is a hard data gap.)',
    '## RELEVANT NEWS',
    newsLines.length ? newsLines.join('\n') : '(No recent gold-related news articles available.)',
  ].join('\n\n');

  return {
    timestamp: new Date().toISOString(),
    promptContext,
    citations,
    observations,
    activeSources,
    coverage,
    degraded: readiness.level !== 'full',
    hasGoldData,
    readiness,
  };
}
