import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import {
  assessGoldAnalystReadiness,
  type GoldAnalystQualityInputs,
} from '../server/worldmonitor/market/v1/gold-analyst-quality.ts';
import {
  closestValueAtOrBefore,
  parseCftcFuturesOnlyText,
  pctChange,
} from '../server/worldmonitor/market/v1/gold-analyst-context.ts';
import {
  resolveGoldAnalystProviderRoute,
} from '../server/worldmonitor/market/v1/gold-analyst-models.ts';

const COMPLETE: GoldAnalystQualityInputs = {
  hasGold: true,
  hasGold24h: true,
  hasSilver: true,
  hasSilver24h: true,
  hasDxy: true,
  hasNominalRates: true,
  hasRealYield: true,
  hasPolicyRate: true,
  hasInflation: true,
  calendarChecked: true,
  hasGoldCot: true,
  hasSilverCot: true,
  hasRealtimePositioning: true,
  hasEtfHoldings: true,
  hasEtfFlows: true,
  hasGoldTechnical: true,
  crossMarketCount: 5,
  hasNews: true,
  hasStress: true,
  hasSentiment: true,
  hasGeopoliticalRisk: true,
  hasPredictionMarkets: true,
  severeRateConflict: false,
};

describe('Gold Analyst quote baselines', () => {
  test('computes an exact percentage change from the supplied baseline', () => {
    assert.equal(pctChange(102.5, 100), 2.5);
    assert.equal(pctChange(100, null), null);
  });

  test('rejects a stale point across a market-closed gap', () => {
    const points = [
      { timestamp: 100, close: 10 },
      { timestamp: 200, close: 11 },
    ];
    assert.deepEqual(closestValueAtOrBefore(points, 230, 45), {
      timestamp: 200,
      close: 11,
    });
    assert.equal(closestValueAtOrBefore(points, 400, 45), null);
  });
});

describe('Gold Analyst CFTC fallback', () => {
  test('maps futures-only managed-money positions and weekly changes', () => {
    const row = (
      market: string,
      contract: string,
      long: number,
      short: number,
      longChange: number,
      shortChange: number,
    ) => {
      const fields = Array.from({ length: 71 }, () => '0');
      fields[0] = `"${market}"`;
      fields[2] = '2026-07-21';
      fields[3] = contract;
      fields[13] = String(long);
      fields[14] = String(short);
      fields[61] = String(longChange);
      fields[62] = String(shortChange);
      return fields.join(',');
    };
    const parsed = parseCftcFuturesOnlyText([
      row('GOLD - COMMODITY EXCHANGE INC.', '088691', 141_487, 16_656, 4_582, 530),
      row('SILVER - COMMODITY EXCHANGE INC.', '084691', 18_204, 6_922, 650, 869),
    ].join('\n'));

    assert.equal(parsed?.reportDate, '2026-07-21');
    assert.deepEqual(parsed?.instruments?.map((instrument) => ({
      code: instrument.code,
      long: instrument.managedMoney?.longPositions,
      short: instrument.managedMoney?.shortPositions,
      delta: instrument.managedMoney?.wowNetDelta,
    })), [
      { code: 'GC', long: 141_487, short: 16_656, delta: 4_052 },
      { code: 'SI', long: 18_204, short: 6_922, delta: -219 },
    ]);
  });
});

describe('Gold Analyst data-readiness gate', () => {
  test('permits full analysis only when positioning/flow coverage is present', () => {
    const result = assessGoldAnalystReadiness(COMPLETE);
    assert.equal(result.score, 100);
    assert.equal(result.level, 'full');
    assert.equal(result.predictionAllowed, true);
  });

  test('marks a high numeric score limited when positioning is absent', () => {
    const result = assessGoldAnalystReadiness({
      ...COMPLETE,
      hasGoldCot: false,
      hasSilverCot: false,
      hasEtfHoldings: true,
      hasEtfFlows: false,
    });
    assert.equal(result.score, 91);
    assert.equal(result.level, 'limited');
    assert.equal(result.predictionAllowed, true);
    assert.ok(result.missing.some((item) => item.includes('CFTC')));
  });

  test('refuses a directional forecast when the 24h baseline is missing', () => {
    const result = assessGoldAnalystReadiness({
      ...COMPLETE,
      hasGold24h: false,
    });
    assert.equal(result.level, 'insufficient');
    assert.equal(result.predictionAllowed, false);
  });

  test('refuses a directional forecast on a severe cross-source rate conflict', () => {
    const result = assessGoldAnalystReadiness({
      ...COMPLETE,
      severeRateConflict: true,
    });
    assert.equal(result.predictionAllowed, false);
    assert.ok(result.warnings.some((item) => item.includes('chênh lệch')));
  });

  test('refuses a directional forecast when broad risk context is absent', () => {
    const result = assessGoldAnalystReadiness({
      ...COMPLETE,
      hasStress: false,
      hasSentiment: false,
      hasGeopoliticalRisk: false,
    });
    assert.equal(result.predictionAllowed, false);
    assert.equal(result.level, 'insufficient');
  });
});

describe('Gold Analyst provider routing', () => {
  test('does not silently add paid OpenAI fallback to a Gemini request', () => {
    const previous = {
      groq: process.env.GROQ_API_KEY,
      gemini: process.env.GEMINI_API_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    process.env.GROQ_API_KEY = 'test';
    process.env.GEMINI_API_KEY = 'test';
    process.env.OPENAI_API_KEY = 'test';
    try {
      const route = resolveGoldAnalystProviderRoute({
        provider: 'gemini',
        model: 'gemini-3.6-flash',
        mode: 'balanced',
        allowFallback: true,
      });
      assert.deepEqual(route?.providerOrder, ['gemini', 'groq']);
    } finally {
      if (previous.groq === undefined) delete process.env.GROQ_API_KEY;
      else process.env.GROQ_API_KEY = previous.groq;
      if (previous.gemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = previous.gemini;
      if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous.openai;
    }
  });
});
