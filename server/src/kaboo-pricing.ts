export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reasoningTokens: number;
}

export interface ModelPricing {
  pattern: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  cacheReadPricePerMTok: number;
  cacheCreationPricePerMTok: number;
  reasoningPricePerMTok: number;
}

export interface PricedModelUsage extends TokenUsage {
  model: string;
  providerEstimatedCostUSD: number;
}

const FALLBACK_PRICING: ModelPricing = {
  pattern: '',
  inputPricePerMTok: 3,
  outputPricePerMTok: 15,
  cacheReadPricePerMTok: 0.3,
  cacheCreationPricePerMTok: 3.75,
  reasoningPricePerMTok: 15,
};

const PRICING: readonly ModelPricing[] = [
  { pattern: 'claude-haiku-4', inputPricePerMTok: 1, outputPricePerMTok: 5, cacheReadPricePerMTok: 0.1, cacheCreationPricePerMTok: 1.25, reasoningPricePerMTok: 5 },
  { pattern: 'claude-sonnet-4', inputPricePerMTok: 3, outputPricePerMTok: 15, cacheReadPricePerMTok: 0.3, cacheCreationPricePerMTok: 3.75, reasoningPricePerMTok: 15 },
  { pattern: 'claude-opus-4', inputPricePerMTok: 15, outputPricePerMTok: 75, cacheReadPricePerMTok: 1.5, cacheCreationPricePerMTok: 18.75, reasoningPricePerMTok: 75 },
  { pattern: 'gpt-4o-mini', inputPricePerMTok: 0.15, outputPricePerMTok: 0.6, cacheReadPricePerMTok: 0.075, cacheCreationPricePerMTok: 0.15, reasoningPricePerMTok: 0.6 },
  { pattern: 'gpt-4o', inputPricePerMTok: 2.5, outputPricePerMTok: 10, cacheReadPricePerMTok: 1.25, cacheCreationPricePerMTok: 2.5, reasoningPricePerMTok: 10 },
];

export function normalizeTokenCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

export function normalizeTokenUsage(input: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: normalizeTokenCount(input.inputTokens),
    outputTokens: normalizeTokenCount(input.outputTokens),
    cacheReadInputTokens: normalizeTokenCount(input.cacheReadInputTokens),
    cacheCreationInputTokens: normalizeTokenCount(input.cacheCreationInputTokens),
    reasoningTokens: normalizeTokenCount(input.reasoningTokens),
  };
}

export function matchModelPricing(model: string): ModelPricing {
  const normalized = model.toLowerCase();
  return PRICING.filter((candidate) => normalized.includes(candidate.pattern))
    .sort((left, right) => right.pattern.length - left.pattern.length)[0] ?? FALLBACK_PRICING;
}

export function estimateModelCostUSD(model: string, input: Partial<TokenUsage>): number {
  const usage = normalizeTokenUsage(input);
  const pricing = matchModelPricing(model);
  return (
    usage.inputTokens * pricing.inputPricePerMTok +
    usage.outputTokens * pricing.outputPricePerMTok +
    usage.cacheReadInputTokens * pricing.cacheReadPricePerMTok +
    usage.cacheCreationInputTokens * pricing.cacheCreationPricePerMTok +
    usage.reasoningTokens * pricing.reasoningPricePerMTok
  ) / 1_000_000;
}

export function priceUsageByModel(
  rootUsage: Partial<TokenUsage>,
  modelUsage?: Record<string, Partial<TokenUsage>>,
): { usage: TokenUsage; models: PricedModelUsage[]; costUSD: number } {
  const entries = Object.entries(modelUsage ?? {}).filter(([model]) => model.trim());
  const source = entries.length > 0 ? entries : [['unknown', rootUsage] as [string, Partial<TokenUsage>]];
  const models = source.map(([rawModel, rawUsage]) => {
    const model = rawModel.trim() || 'unknown';
    const usage = normalizeTokenUsage(rawUsage);
    return { model, ...usage, providerEstimatedCostUSD: estimateModelCostUSD(model, usage) };
  });
  const usage = models.reduce<TokenUsage>((total, model) => ({
    inputTokens: total.inputTokens + model.inputTokens,
    outputTokens: total.outputTokens + model.outputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + model.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + model.cacheCreationInputTokens,
    reasoningTokens: total.reasoningTokens + model.reasoningTokens,
  }), normalizeTokenUsage({}));
  return { usage, models, costUSD: models.reduce((sum, model) => sum + model.providerEstimatedCostUSD, 0) };
}
