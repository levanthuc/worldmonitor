import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GOLD_ANALYST_PANEL_CACHE_KEYS,
  aggregateConflictEvents,
  calculateCpiYoY,
  calculateHyperliquidOiDelta1h,
  filterRelevantPredictionMarkets,
  loadGoldAnalystPanelContext,
} from '../server/worldmonitor/market/v1/gold-analyst-panel-context';

const NOW = Date.parse('2026-07-30T03:00:00.000Z');

describe('gold analyst panel pure helpers', () => {
  it('calculates CPI YoY from the same calendar month, regardless of input order', () => {
    const result = calculateCpiYoY([
      { date: '2026-06-01', value: 321.5 },
      { date: '2025-05-01', value: 311 },
      { date: '2025-06-01', value: 312.25 },
      { date: 'bad-date', value: 999 },
    ]);

    assert.ok(result);
    assert.equal(result.currentDate, '2026-06-01');
    assert.equal(result.priorDate, '2025-06-01');
    assert.ok(Math.abs(result.yoyPct - ((321.5 / 312.25 - 1) * 100)) < 0.000_001);
  });

  it('refuses to manufacture CPI YoY from an adjacent missing month', () => {
    assert.equal(calculateCpiYoY([
      { date: '2025-05-01', value: 310 },
      { date: '2026-06-01', value: 320 },
    ]), null);
  });

  it('uses 12 five-minute intervals for a true Hyperliquid one-hour OI delta', () => {
    const result = calculateHyperliquidOiDelta1h([
      100, 101, 102, 103, 104, 105, 106,
      107, 108, 109, 110, 111, 125,
    ]);

    assert.deepEqual(result, {
      current: 125,
      oneHourAgo: 100,
      absolute: 25,
      pct: 25,
      sampleIntervalMinutes: 5,
      intervals: 12,
    });
    assert.equal(calculateHyperliquidOiDelta1h(new Array(12).fill(100)), null);
    assert.equal(calculateHyperliquidOiDelta1h([0, ...new Array(12).fill(100)]), null);
  });

  it('keeps only non-expired gold-relevant prediction markets and deduplicates them', () => {
    const result = filterRelevantPredictionMarkets([
      {
        title: 'Will the Fed cut rates before September?',
        yesPrice: 67,
        volume: 50_000,
        url: 'https://example.test/fed',
        endDate: '2026-09-01T00:00:00Z',
        source: 'polymarket',
      },
      {
        title: 'Duplicate lower-volume Fed market',
        yesPrice: 66,
        volume: 1_000,
        url: 'https://example.test/fed',
        endDate: '2026-09-01T00:00:00Z',
      },
      {
        title: 'Will a ceasefire be signed in Ukraine?',
        yesPrice: 40,
        volume: 75_000,
        endDate: '2026-08-30T00:00:00Z',
      },
      {
        title: 'Who wins the football final?',
        yesPrice: 50,
        volume: 1_000_000,
      },
      {
        title: 'Will gold reach a record high?',
        yesPrice: 80,
        volume: 1_000_000,
        endDate: '2026-01-01T00:00:00Z',
      },
    ], { nowMs: NOW });

    assert.equal(result.length, 2);
    assert.equal(result[0]?.title, 'Will the Fed cut rates before September?');
    assert.deepEqual(result[0]?.relevanceSignals, ['Federal Reserve/rates']);
    assert.equal(result[1]?.title, 'Will a ceasefire be signed in Ukraine?');
  });

  it('aggregates conflict windows, deaths, countries, and ignores future rows', () => {
    const result = aggregateConflictEvents([
      {
        id: 'recent',
        dateStart: NOW - (2 * 60 * 60 * 1000),
        country: 'Country A',
        deathsBest: 5,
      },
      {
        id: 'week',
        dateStart: Math.floor((NOW - (3 * 24 * 60 * 60 * 1000)) / 1000),
        country: 'Country B',
        deathsBest: 12,
      },
      {
        id: 'month',
        dateStart: '2026-07-10T00:00:00Z',
        country: 'Country B',
        deathsBest: 20,
      },
      {
        id: 'old',
        dateStart: '2026-05-01T00:00:00Z',
        country: 'Country C',
        deathsBest: 100,
      },
      {
        id: 'future',
        dateStart: NOW + 60_000,
        country: 'Country D',
        deathsBest: 999,
      },
    ], { nowMs: NOW });

    assert.equal(result.validEventCount, 4);
    assert.equal(result.events24h, 1);
    assert.equal(result.events7d, 2);
    assert.equal(result.events30d, 3);
    assert.equal(result.deathsBest30d, 37);
    assert.deepEqual(result.topCountries30d[0], {
      country: 'Country B',
      events30d: 2,
      deathsBest30d: 32,
    });
    assert.equal(result.recentEvents[0]?.id, 'recent');
  });
});

describe('loadGoldAnalystPanelContext', () => {
  it('fills local cache misses only from WorldMonitor public fast/slow bootstrap tiers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const cpi = {
      series: {
        seriesId: 'CPIAUCSL',
        title: 'Consumer Price Index',
        units: 'Index',
        frequency: 'Monthly',
        observations: [
          { date: '2025-06-01', value: 312.25 },
          { date: '2026-06-01', value: 321.5 },
        ],
      },
    };
    const fedFunds = {
      series: {
        seriesId: 'FEDFUNDS',
        title: 'Effective Federal Funds Rate',
        units: 'Percent',
        frequency: 'Monthly',
        observations: [{ date: '2026-06-01', value: 4.25 }],
      },
    };
    const cacheReader = async (keys: string[], raw?: boolean) => {
      assert.equal(keys.length, 10);
      assert.equal(raw, true);
      return new Map<string, unknown>([
        [GOLD_ANALYST_PANEL_CACHE_KEYS.cpi, cpi],
        [GOLD_ANALYST_PANEL_CACHE_KEYS.fedFunds, fedFunds],
      ]);
    };
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const data = url.includes('tier=fast')
        ? {
            riskScores: {
              ciiScores: [{
                region: 'UA',
                combinedScore: 85,
                dynamicScore: 8,
                trend: 'TREND_DIRECTION_UP',
                advisoryLevel: 'high',
                computedAt: NOW - 60_000,
              }],
              strategicRisks: [],
              degraded: false,
              stale: false,
            },
            predictions: {
              finance: [{
                title: 'Will the Fed cut rates in September?',
                yesPrice: 70,
                volume: 100_000,
                endDate: '2026-09-30',
              }],
              geopolitical: [],
              fetchedAt: NOW - 120_000,
            },
            marketQuotes: {
              quotes: [
                {
                  symbol: '^GSPC',
                  name: 'S&P 500',
                  display: 'SPX',
                  price: 6_100,
                  change: -1.2,
                  sparkline: [6_150, 6_100],
                },
              ],
            },
          }
        : {
            fearGreedIndex: {
              timestamp: new Date(NOW - 180_000).toISOString(),
              composite: { score: 35, label: 'Fear', previous: 42 },
              categories: {},
              headerMetrics: {},
            },
            economicStress: {
              compositeScore: 62,
              label: 'Elevated',
              components: [],
              seededAt: new Date(NOW - 240_000).toISOString(),
              unavailable: false,
            },
            hyperliquidFlow: {
              fetchedAt: new Date(NOW - 300_000).toISOString(),
              warmup: false,
              assets: [{
                symbol: 'xyz:GOLD',
                display: 'Gold',
                class: 'commodity',
                group: 'metals',
                openInterest: 125,
                sparkOi: [
                  100, 101, 102, 103, 104, 105, 106,
                  107, 108, 109, 110, 111, 125,
                ],
              }],
            },
            sanctionsPressure: {
              fetchedAt: String(NOW - 360_000),
              totalCount: 10,
              newEntryCount: 1,
              countries: [{ countryCode: 'RU', countryName: 'Russia', entryCount: 10 }],
              programs: [],
              entries: [],
            },
            ucdpEvents: {
              fetchedAt: NOW - 420_000,
              events: [{
                id: 'event-1',
                dateStart: NOW - 3_600_000,
                country: 'Ukraine',
                deathsBest: 4,
              }],
            },
          };
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const result = await loadGoldAnalystPanelContext({
      cacheReader,
      fetchFn,
      isLocalDev: true,
      now: () => NOW,
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => call.url).sort(),
      [
        'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1',
        'https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1',
      ],
    );
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get('Origin'), 'https://worldmonitor.app');
      assert.equal(headers.has('Authorization'), false);
    }
    assert.equal(result.usedLocalBootstrapFallback, true);
    assert.equal(result.sourceAvailability.fearGreed.provenance, 'worldmonitor-bootstrap');
    assert.equal(result.sourceAvailability.cpi.provenance, 'cache');
    assert.equal(result.macro.latestFedFundsRate, 4.25);
    assert.ok(result.macro.cpiYoY);
    assert.equal(result.hyperliquidMetals?.assets[0]?.oiDelta1h?.pct, 25);
    assert.equal(result.conflicts?.events24h, 1);
    assert.equal(result.predictionMarkets.length, 1);
    assert.equal(result.markets?.breadth.declining, 1);
  });

  it('does not make any external request outside explicitly enabled local development', async () => {
    let fetches = 0;
    const result = await loadGoldAnalystPanelContext({
      cacheReader: async () => new Map(),
      fetchFn: (async () => {
        fetches += 1;
        throw new Error('must not fetch');
      }) as typeof fetch,
      isLocalDev: false,
      now: () => NOW,
    });

    assert.equal(fetches, 0);
    assert.equal(result.usedLocalBootstrapFallback, false);
    assert.equal(result.sourceAvailability.fearGreed.available, false);
    assert.equal(result.sourceAvailability.fedFunds.available, false);
  });
});
