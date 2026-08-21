import crypto from 'node:crypto';
import type { PiProviderSelection } from '@deep-worker/pi-runner';
import type { ProviderConfigRow } from './provider-store.js';

export type ProviderBalanceStrategy = 'round-robin' | 'weighted' | 'failover';

export interface ProviderBalanceConfig {
  strategy: ProviderBalanceStrategy;
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface ProviderHealthStatus {
  id: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

const DEFAULT_BALANCE: ProviderBalanceConfig = {
  strategy: 'round-robin',
  unhealthyThreshold: 2,
  recoveryIntervalMs: 60_000,
};

interface Member extends ProviderConfigRow {}

function makeHealth(id: string): ProviderHealthStatus {
  return {
    id,
    healthy: true,
    consecutiveErrors: 0,
    lastErrorAt: null,
    lastSuccessAt: null,
    unhealthySince: null,
    activeSessionCount: 0,
  };
}

export class ProviderPool {
  private members: Member[] = [];
  private balance = { ...DEFAULT_BALANCE };
  private readonly health = new Map<string, ProviderHealthStatus>();
  private readonly sticky = new Map<string, string>();
  private cursor = 0;

  refreshFromConfig(
    members: ProviderConfigRow[],
    balance: Partial<ProviderBalanceConfig> = {},
  ): void {
    this.members = members.map((member) => ({
      ...member,
      weight: Math.max(1, Math.min(100, member.weight || 1)),
    }));
    this.balance = {
      ...DEFAULT_BALANCE,
      ...balance,
      unhealthyThreshold: Math.max(
        1,
        Math.floor(balance.unhealthyThreshold ?? DEFAULT_BALANCE.unhealthyThreshold),
      ),
      recoveryIntervalMs: Math.max(
        1_000,
        Math.floor(balance.recoveryIntervalMs ?? DEFAULT_BALANCE.recoveryIntervalMs),
      ),
    };
    const ids = new Set(this.members.map((member) => member.id));
    for (const id of this.health.keys()) if (!ids.has(id)) this.health.delete(id);
    for (const [sessionId, id] of this.sticky) if (!ids.has(id)) this.sticky.delete(sessionId);
  }

  selectProvider(sessionId?: string): ProviderConfigRow | undefined {
    this.refreshRecoveryState();
    const candidate = sessionId ? this.sticky.get(sessionId) : undefined;
    if (candidate && this.isHealthy(candidate)) {
      const selected = this.members.find(
        (member) => member.id === candidate && member.enabled === 1,
      );
      if (selected) return selected;
    }
    const candidates = this.members.filter(
      (member) => member.enabled === 1 && this.isHealthy(member.id),
    );
    if (!candidates.length) return undefined;
    let selected: Member;
    if (this.balance.strategy === 'failover') {
      selected = candidates[0]!;
    } else if (this.balance.strategy === 'weighted') {
      const total = candidates.reduce((sum, member) => sum + member.weight, 0);
      let offset = this.cursor++ % total;
      selected = candidates[0]!;
      for (const member of candidates) {
        if (offset < member.weight) {
          selected = member;
          break;
        }
        offset -= member.weight;
      }
    } else {
      selected = candidates[this.cursor++ % candidates.length]!;
    }
    if (sessionId) {
      this.sticky.set(sessionId, selected.id);
      this.getHealth(selected.id).activeSessionCount += 1;
    }
    return selected;
  }

  reportSuccess(id: string): void {
    const health = this.getHealth(id);
    health.consecutiveErrors = 0;
    health.lastSuccessAt = Date.now();
    health.healthy = true;
    health.unhealthySince = null;
  }

  reportFailure(id: string, immediate = false): void {
    const health = this.getHealth(id);
    health.consecutiveErrors = immediate
      ? Math.max(this.balance.unhealthyThreshold, health.consecutiveErrors + 1)
      : health.consecutiveErrors + 1;
    health.lastErrorAt = Date.now();
    if (health.consecutiveErrors >= this.balance.unhealthyThreshold) {
      health.healthy = false;
      health.unhealthySince ??= Date.now();
      for (const [sessionId, providerId] of this.sticky)
        if (providerId === id) this.sticky.delete(sessionId);
    }
  }

  refreshRecoveryState(now = Date.now()): void {
    for (const health of this.health.values()) {
      if (
        !health.healthy &&
        health.unhealthySince !== null &&
        now - health.unhealthySince >= this.balance.recoveryIntervalMs
      ) {
        health.healthy = true;
        health.consecutiveErrors = 0;
        health.unhealthySince = null;
      }
    }
  }

  getHealthStatuses(): ProviderHealthStatus[] {
    return this.members.map((member) => ({ ...this.getHealth(member.id) }));
  }

  getHealth(id: string): ProviderHealthStatus {
    const existing = this.health.get(id);
    if (existing) return existing;
    const created = makeHealth(id);
    this.health.set(id, created);
    return created;
  }

  private isHealthy(id: string): boolean {
    return this.getHealth(id).healthy;
  }
}

function providerEnvName(provider: string, suffix: string): string {
  return `${provider.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_${suffix}`;
}

function providerApi(provider: string) {
  const normalized = provider.trim().toLowerCase();
  if (normalized === 'anthropic') return 'anthropic-messages' as const;
  if (normalized === 'google' || normalized === 'gemini')
    return 'google-generative-ai' as const;
  return 'openai-completions' as const;
}

export function mapProviderToPiProvider(
  config: ProviderConfigRow,
  credentials: Record<string, unknown>,
): PiProviderSelection {
  const env: NodeJS.ProcessEnv = {};
  const apiKey = credentials.apiKey ?? credentials.api_key ?? credentials.token;
  const apiKeyEnv = providerEnvName(config.provider, 'API_KEY');
  if (typeof apiKey === 'string' && apiKey) env[apiKeyEnv] = apiKey;
  if (config.base_url) env[providerEnvName(config.provider, 'BASE_URL')] = config.base_url;
  const hash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        id: config.id,
        provider: config.provider,
        modelId: config.model_id,
        baseUrl: config.base_url,
        credentials,
      }),
    )
    .digest('hex');
  return {
    provider: config.provider,
    modelId: config.model_id,
    env,
    hash,
    modelConfig: config.base_url
      ? {
          baseUrl: config.base_url,
          api: providerApi(config.provider),
          apiKeyEnv,
          input: /vision/i.test(config.model_id) ? ['text', 'image'] : ['text'],
        }
      : undefined,
  };
}

export function defaultProviderBalance(): ProviderBalanceConfig {
  return { ...DEFAULT_BALANCE };
}
