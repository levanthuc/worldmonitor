export type GoldAnalystReadinessLevel = 'full' | 'limited' | 'insufficient';

export interface GoldAnalystQualityInputs {
  hasGold: boolean;
  hasGold24h: boolean;
  hasSilver: boolean;
  hasSilver24h: boolean;
  hasDxy: boolean;
  hasNominalRates: boolean;
  hasRealYield: boolean;
  hasPolicyRate: boolean;
  hasInflation: boolean;
  calendarChecked: boolean;
  hasGoldCot: boolean;
  hasSilverCot: boolean;
  hasRealtimePositioning: boolean;
  hasEtfHoldings: boolean;
  hasEtfFlows: boolean;
  hasGoldTechnical: boolean;
  crossMarketCount: number;
  hasNews: boolean;
  hasStress: boolean;
  hasSentiment: boolean;
  hasGeopoliticalRisk: boolean;
  hasPredictionMarkets: boolean;
  severeRateConflict: boolean;
}

export interface GoldAnalystReadinessCategory {
  id: 'market' | 'ratesUsd' | 'calendarInflation' | 'positioningFlows' | 'technicalCross' | 'news' | 'riskSentiment';
  label: string;
  score: number;
  maxScore: number;
}

export interface GoldAnalystReadiness {
  score: number;
  level: GoldAnalystReadinessLevel;
  predictionAllowed: boolean;
  categories: GoldAnalystReadinessCategory[];
  missing: string[];
  warnings: string[];
}

export function assessGoldAnalystReadiness(
  input: GoldAnalystQualityInputs,
): GoldAnalystReadiness {
  const market = (input.hasGold ? 10 : 0)
    + (input.hasGold24h ? 5 : 0)
    + (input.hasSilver ? 3 : 0)
    + (input.hasSilver24h ? 2 : 0);
  const ratesUsd = (input.hasDxy ? 7 : 0)
    + (input.hasRealYield ? 8 : 0)
    + (input.hasNominalRates ? 4 : 0)
    + (input.hasPolicyRate ? 1 : 0);
  const calendarInflation = (input.calendarChecked ? 10 : 0)
    + (input.hasInflation ? 5 : 0);
  const positioningFlows = (input.hasGoldCot ? 5 : 0)
    + (input.hasSilverCot ? 2 : 0)
    + (input.hasRealtimePositioning ? 4 : 0)
    + (input.hasEtfFlows ? 4 : input.hasEtfHoldings ? 2 : 0);
  const technicalCross = (input.hasGoldTechnical ? 5 : 0)
    + Math.min(5, Math.max(0, input.crossMarketCount));
  const news = input.hasNews ? 5 : 0;
  const riskSentiment = (input.hasStress ? 4 : 0)
    + (input.hasSentiment ? 4 : 0)
    + (input.hasGeopoliticalRisk ? 4 : 0)
    + (input.hasPredictionMarkets ? 3 : 0);

  const categories: GoldAnalystReadinessCategory[] = [
    { id: 'market', label: 'Vàng/Bạc & mốc so sánh', score: market, maxScore: 20 },
    { id: 'ratesUsd', label: 'USD, lợi suất & lãi suất chính sách', score: ratesUsd, maxScore: 20 },
    { id: 'calendarInflation', label: 'Lịch vĩ mô & lạm phát', score: calendarInflation, maxScore: 15 },
    { id: 'positioningFlows', label: 'Vị thế & dòng tiền', score: positioningFlows, maxScore: 15 },
    { id: 'technicalCross', label: 'Kỹ thuật & liên thị trường', score: technicalCross, maxScore: 10 },
    { id: 'news', label: 'Tin tức liên quan', score: news, maxScore: 5 },
    { id: 'riskSentiment', label: 'Stress, tâm lý & địa chính trị', score: riskSentiment, maxScore: 15 },
  ];
  const score = categories.reduce((sum, category) => sum + category.score, 0);

  const missing: string[] = [];
  if (!input.hasGold) missing.push('giá hợp đồng vàng hiện tại');
  if (!input.hasGold24h) missing.push('mốc giá vàng cùng hợp đồng cách 24 giờ');
  if (!input.hasSilver) missing.push('giá bạc');
  if (!input.hasDxy) missing.push('DXY');
  if (!input.hasRealYield) missing.push('lợi suất thực Mỹ');
  if (!input.hasNominalRates) missing.push('đường cong lợi suất danh nghĩa Mỹ');
  if (!input.hasPolicyRate) missing.push('lãi suất chính sách/Fed Funds');
  if (!input.hasInflation) missing.push('CPI/lạm phát Mỹ');
  if (!input.calendarChecked) missing.push('lịch công bố vĩ mô 24 giờ');
  if (!input.hasGoldCot) missing.push('vị thế CFTC vàng');
  if (!input.hasRealtimePositioning) missing.push('vị thế 24/7 vàng/bạc');
  if (!input.hasEtfFlows) {
    missing.push(input.hasEtfHoldings
      ? 'biến động dòng vốn ETF vàng (chỉ có holdings hiện tại)'
      : 'dòng vốn ETF vàng');
  }
  if (!input.hasNews) missing.push('tin tức vàng/vĩ mô gần đây');
  if (!input.hasStress) missing.push('macro/financial stress');
  if (!input.hasSentiment) missing.push('Fear & Greed/tâm lý thị trường');
  if (!input.hasGeopoliticalRisk) missing.push('xung đột/bất ổn/trừng phạt');
  if (!input.hasPredictionMarkets) missing.push('prediction markets liên quan');

  const warnings: string[] = [];
  if (input.severeRateConflict) {
    warnings.push('Lợi suất 10 năm từ hai nguồn chênh lệch quá lớn; không dùng để dự báo hướng.');
  }
  if (!input.hasEtfFlows) {
    warnings.push(input.hasEtfHoldings
      ? 'Có holdings GLD hiện tại nhưng không có chuỗi thay đổi 1W/1M; không suy diễn dòng vốn.'
      : 'Không có dòng vốn ETF mới; phần nhu cầu nhà đầu tư tổ chức bị thiếu.');
  }
  if (!input.hasPredictionMarkets) {
    warnings.push('Không có prediction market phù hợp; không suy diễn xác suất địa chính trị.');
  }

  const broadContextCount = [
    input.hasStress,
    input.hasSentiment,
    input.hasGeopoliticalRisk,
  ].filter(Boolean).length;
  const hardRequirementsMet = input.hasGold
    && input.hasGold24h
    && input.hasSilver
    && input.hasDxy
    && (input.hasRealYield || input.hasNominalRates)
    && input.calendarChecked
    && input.hasInflation
    && (input.hasGoldCot || input.hasRealtimePositioning)
    && input.hasGoldTechnical
    && input.crossMarketCount >= 3
    && input.hasNews
    && broadContextCount >= 2
    && !input.severeRateConflict;
  const predictionAllowed = hardRequirementsMet && score >= 70;
  const level: GoldAnalystReadinessLevel = !predictionAllowed
    ? 'insufficient'
    : score >= 85
      && positioningFlows >= 9
      && riskSentiment >= 8
      ? 'full'
      : 'limited';

  return {
    score,
    level,
    predictionAllowed,
    categories,
    missing,
    warnings,
  };
}
