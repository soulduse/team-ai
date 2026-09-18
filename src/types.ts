export type ProviderId = 'claude' | 'codex';

export interface StoredAccount {
  id: string;
  provider: ProviderId;
  label: string;
  enabled: boolean;
  priority: number | null;
  credentialId: string;
  createdAt: string;
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  accountId: string;
}

export interface TeamAIConfig {
  version: 1;
  proxy: { host: string; claudePort: number; codexPort: number; controlPort?: number; clientToken: string };
  switchThreshold: number;
  warmupIntervalMs?: number;
  maxConcurrentPerAccount: number;
  // At or above this share of the model-weekly (Fable) window, an account counts
  // as spent for that model and becomes the preferred home for traffic that does
  // not need it. Below it, the account is held back so its remaining Fable budget
  // is not consumed by Opus/Sonnet requests that any account could serve.
  // 1 disables the split and restores plain least-spent routing.
  fableReserveThreshold?: number;
  accounts: StoredAccount[];
}

export interface ProbeTemplate {
  path: string;
  model: string;
  version: string;
  beta: string | null;
  system: unknown;
  userAgent: string | null;
  query: string;
  elicitsModelWeekly: boolean;
}

export interface QuotaWindow {
  usage: number | null;
  resetsAt: number | null;
  minutes?: number | null;
}

export interface QuotaSnapshot {
  routingUsage: number | null;
  routingResetsAt: number | null;
  windows: Record<string, QuotaWindow>;
}

export interface SubscriptionProfile {
  status: string | null;
  createdAt: string | null;
  rateLimitTier: string | null;
  orgType: string | null;
  hasClaudeMax: boolean | null;
  hasClaudePro: boolean | null;
  fetchedAt: number;
}

export interface AccountRuntimeState {
  usage: number | null;
  resetsAt: number | null;
  windows?: Record<string, QuotaWindow>;
  profile?: SubscriptionProfile | null;
  cooldownUntil: number | null;
  lastUsed: number | null;
  error: string | null;
}

export interface PersistedState {
  version: 1;
  accounts: Record<string, AccountRuntimeState>;
  events?: Array<{ at: number; message: string }>;
}

export interface RuntimeAccount extends StoredAccount {
  credential: OAuthCredential;
  usage: number | null;
  resetsAt: number | null;
  cooldownUntil: number | null;
  lastUsed: number | null;
  error: string | null;
  windows: Record<string, QuotaWindow>;
  profile: SubscriptionProfile | null;
  inflight: number;
}

export interface FailureDecision {
  kind: 'quota' | 'auth' | 'forbidden' | 'transient' | 'fatal';
  retryAfterMs: number;
}

export interface Provider {
  id: ProviderId;
  label: string;
  upstreamBase: string;
  normalizePath(path: string): string | null;
  buildHeaders(incoming: Headers, account: RuntimeAccount): Headers;
  rewriteBody(body: Buffer, account: RuntimeAccount): Buffer;
  readQuota(headers: Headers, body?: string): QuotaSnapshot | null;
  classifyFailure(status: number, headers: Headers, body: string): FailureDecision;
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
  fableModel?: string;
  // Whether a request spends the model-weekly (Fable) budget. Providers without
  // such a split leave this undefined and every request ranks the same way.
  usesFableBudget?(path: string, body: Buffer): boolean;
  defaultProbe?(): ProbeTemplate | null;
  captureProbe?(path: string, headers: Headers, body: Buffer, sawModelWeekly: boolean): ProbeTemplate | null;
  probeRequest?(template: ProbeTemplate, credential: OAuthCredential): { url: string; headers: Record<string, string>; body: string };
  fetchProfile?(credential: OAuthCredential): Promise<SubscriptionProfile>;
}
