import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildGoldAnalystCopyBundle } from '../server/worldmonitor/market/v1/gold-analyst-export.ts';
import type { GoldAnalystContext } from '../server/worldmonitor/market/v1/gold-analyst-context.ts';

const CONTEXT: GoldAnalystContext = {
  timestamp: '2026-07-30T10:18:00.000Z',
  promptContext: 'internal prompt-only data',
  citations: [{
    id: 'D1',
    label: 'Gold Aug 26 (GC=F)',
    url: 'https://example.test/gold',
    asOf: '2026-07-30T10:18:00.000Z',
    kind: 'market',
  }],
  observations: [{
    id: 'D1',
    category: 'precious',
    label: 'Gold Aug 26 (GC=F)',
    value: '4,139.80 USD/oz; 24h +1.25%',
    source: 'Yahoo Finance',
    asOf: '2026-07-30T10:18:00.000Z',
    baseline: 'exact same contract 24 hours earlier',
    freshness: 'live',
  }, {
    id: 'N1',
    category: 'news',
    label: 'Example headline',
    value: 'Topic precious; headline only',
    source: 'Example News',
    asOf: '2026-07-28T10:18:00.000Z',
    freshness: 'stale',
  }],
  activeSources: ['Yahoo Finance', 'Live news'],
  coverage: [{
    id: 'gold-silver',
    label: 'GOLD & SILVER',
    status: 'available',
    observationIds: ['D1'],
    note: 'Futures quote available.',
  }, {
    id: 'mining-news',
    label: 'MINING NEWS',
    status: 'partial',
    observationIds: ['N1'],
    note: 'Headline metadata only.',
  }],
  degraded: false,
  hasGoldData: true,
  readiness: {
    score: 85,
    level: 'limited',
    predictionAllowed: true,
    categories: [],
    missing: [],
    warnings: ['Only headline metadata is supplied.'],
  },
};

describe('Gold Analyst copy bundle', () => {
  it('exports every observation, source, coverage limitation, and safety rule', () => {
    const bundle = buildGoldAnalystCopyBundle(CONTEXT);

    assert.equal(bundle.format, 'worldmonitor-gold-silver-evidence-v1');
    assert.equal(bundle.observationCount, 2);
    assert.equal(bundle.citationCount, 1);
    assert.match(bundle.prompt, /Use only the evidence package below/);
    assert.match(bundle.prompt, /Do not search the web/);
    assert.match(bundle.prompt, /\[D1\] Gold Aug 26 \(GC=F\): 4,139\.80 USD\/oz; 24h \+1\.25%/);
    assert.match(bundle.prompt, /\[N1\] Example headline/);
    assert.match(bundle.prompt, /Freshness: stale/);
    assert.match(bundle.prompt, /\[PARTIAL\] MINING NEWS/);
    assert.match(bundle.prompt, /https:\/\/example\.test\/gold/);
    assert.doesNotMatch(bundle.prompt, /internal prompt-only data/);
  });
});
