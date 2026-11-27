import type { SyncConfig } from './sync.js';
// Every provider the relay fronts, in display order.
export const PROVIDER_IDS = ['claude', 'codex', 'grok'] as const;
export type ProviderId = typeof PROVIDER_IDS[number];

// A part of the dashboard the user can hide from the `v` menu. Only hidden
// items are stored, so anything added later shows up by default.
export type DisplayItem =
  | 'section:claude' | 'section:codex' | 'section:grok'
  | 'gauge:5h' | 'gauge:7d' | 'gauge:fable' | 'gauge:resets' | 'gauge:codex-1' | 'gauge:codex-2' | 'gauge:grok'
  | 'col:plan' | 'col:state' | 'col:order' | 'col:renewal' | 'col:age'
  | 'activity';

export interface StoredAccount {
  id: string;
  provider: ProviderId;
  label: string;
  enabled: boolean;
  priority: number | null;
  // Fable first: Fable turns go here ahead of every other account, and no other
  // model is served while it has Fable budget left. Once its Fable window is
  // spent, Fable spills to the pool and this account serves other models.
  fableOnly?: boolean;
  credentialId: string;
  createdAt: string;
}

export interface OAuthCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  accountId: string;
  // Codex only: the ChatGPT user behind the token. accountId names the
  // workspace and is what the chatgpt-account-id header needs, but every member
  // of a Business/Team workspace shares it, so it cannot tell two members apart.
  userId?: string;
  // Claude only: the organization the token is scoped to. accountId names the
  // person, but one email can hold a personal plan and a Team seat at once, and
  // each organization has its own subscription and usage limits.
  organizationId?: string;
}

export interface TeamAIConfig {
  version: 1;
  proxy: {
    host: string; claudePort: number; codexPort: number; controlPort?: number; clientToken: string;
    // Optional so configs written before Grok support keep loading; see providerPort().
    grokPort?: number;
    // Extra ports to keep answering on, per provider. Clients receive their base
    // URL at startup and cannot be redirected afterwards, so a port change would
    // otherwise strand every open session; listing the old port here keeps those
    // sessions alive. The built-in default port is always included.
    legacyPorts?: Partial<Record<ProviderId, number[]>>;
  };
  switchThreshold: number;
  warmupIntervalMs?: number;
  maxConcurrentPerAccount: number;
  // At or above this share of the model-weekly (Fable) window, an account counts
  // as spent for that model and becomes the preferred home for traffic that does
  // not need it. Below it, the account is held back so its remaining Fable budget
  // is not consumed by Opus/Sonnet requests that any account could serve.
  // 1 disables the split and restores plain least-spent routing.
  fableReserveThreshold?: number;
  // Dashboard parts the user switched off; display only, routing ignores it.
  display?: { hidden?: DisplayItem[] };
  // Follow another machine's logins instead of refreshing them here (sync.ts).
  sync?: SyncConfig;
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
  // Limit-reset tickets the account holds (Claude `cedar_ember` grants); absent
  // when the response did not carry them, so an older reading is kept.
  resetCredits?: ResetCredits | null;
}

// Counts only: TeamAI shows the tickets, it never redeems one.
export interface ResetCredits {
  general: number; // clears the whole weekly limit
  fable: number; // clears the model-scoped (Fable) weekly window only
  nextExpiry: number | null; // soonest expiry among the counted tickets
  // When the counts were read. A response that stops carrying tickets keeps the
  // last counts, so a reader judges their age by this (missing = unknown age).
  readAt?: number;
}

// Whether a subscription is in good standing. No profile or no status is
// unknown, not unhealthy. Routing and the dashboard both judge by this.
export function subscriptionHealthy(profile: Pick<SubscriptionProfile, 'status'> | null | undefined): boolean {
  return !profile?.status || ['active', 'trialing'].includes(profile.status);
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
  // Why `error` is set, when a token refresh set it: 'unreachable' heals on its
  // own (the relay retries), 'refused' needs a re-login. Absent in state
  // written before the two were told apart.
  errorKind?: RefreshErrorKind | null;
  // Why the last usage-endpoint read failed ("403", "timeout"), cleared by the
  // next reading from any route. Without it a failing read left the old figures
  // in place looking merely old, never broken.
  measureError?: string | null;
  // When the quota figures above were last read from upstream, by any route
  // (response headers, the usage endpoint, a probe). The dashboard shows their
  // age so a number nobody has re-read does not pass for a live one.
  measuredAt?: number | null;
  resetCredits?: ResetCredits | null;
}

export interface PersistedState {
  version: 1;
  accounts: Record<string, AccountRuntimeState>;
  events?: Array<{ at: number; message: string }>;
  // The relay's own notices — token refresh failures and recoveries, adopted
  // re-logins, fleet changes — kept apart from events, where request lines
  // would push them out within minutes. Shown by `teamai status`.
  notices?: Array<{ at: number; message: string }>;
  // The warm-up probe shape learned from live traffic, per provider. Without it
  // a restarted proxy falls back to a hardcoded client version that upstream may
  // reject on version grounds, leaving every account unmeasured until real
  // traffic reseeds the template.
  probes?: Partial<Record<ProviderId, ProbeTemplate>>;
}

// 'unreachable' and 'refused' come from a token refresh. 'blocked' is not a token
// problem: upstream refuses OAuth for the account's organization (Anthropic does
// this while a subscription is past due). It heals when a usage read answers again.
export type RefreshErrorKind = 'unreachable' | 'refused' | 'blocked';

// What one token-refresh sweep did: counts for the summary, and a line per
// account that failed or recovered for the notices.
export interface RefreshSweep {
  healed: number;
  failed: number;
  unreachable: number;
  // Another sweep was already running, so this one did nothing.
  skipped?: boolean;
  outcomes: Array<{ label: string; kind: RefreshErrorKind | 'healed'; message: string }>;
}

export interface RuntimeAccount extends StoredAccount {
  credential: OAuthCredential;
  usage: number | null;
  resetsAt: number | null;
  cooldownUntil: number | null;
  // Why the account is cooling down: a network cooldown benches it for a
  // moment but does not make it a lost home; a quota/forbidden one does.
  cooldownReason: 'network' | 'quota' | 'forbidden' | null;
  lastUsed: number | null;
  error: string | null;
  errorKind?: RefreshErrorKind | null;
  measureError?: string | null;
  windows: Record<string, QuotaWindow>;
  profile: SubscriptionProfile | null;
  measuredAt: number | null;
  resetCredits?: ResetCredits | null;
  inflight: number;
}

// What only the running server knows: requests in flight and why an account
// is benched. state.json carries neither.
export interface LiveAccountStatus {
  credentialId: string;
  inflight: number;
  cooldownUntil: number | null;
  cooldownReason: RuntimeAccount['cooldownReason'];
}

export interface FailureDecision {
  // 'quota' benches the whole account; 'model-quota' means only the
  // model-weekly (Fable) budget is spent, so the account still serves every
  // other model and is excluded from this request alone.
  // 'blocked' is a 403 that names the account's organization, not the request:
  // the account is benched until it answers again, with no 'every account 403s'
  // doubt to hold the bench back.
  kind: 'quota' | 'model-quota' | 'auth' | 'forbidden' | 'blocked' | 'transient' | 'fatal';
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
  // The client's own session identifier, so every request of one session lands
  // on the same account and its prompt cache stays warm. null when the request
  // names none; the proxy then falls back to per-connection identity.
  sessionKey?(headers: Headers, body: Buffer): string | null;
  defaultProbe?(): ProbeTemplate | null;
  captureProbe?(path: string, headers: Headers, body: Buffer, sawModelWeekly: boolean): ProbeTemplate | null;
  probeRequest?(template: ProbeTemplate, credential: OAuthCredential): { url: string; headers: Record<string, string>; body: string };
  fetchProfile?(credential: OAuthCredential): Promise<SubscriptionProfile>;
  // The subscription's own usage read-out — what the client's /usage (Claude)
  // or /status (Codex) screen shows. Unlike a probe it is not a model call, so
  // it spends no quota and can run on a timer across the whole fleet.
  // userAgent: the live client's, when the relay has seen one (Claude asks for it).
  fetchUsage?(credential: OAuthCredential, userAgent?: string | null): Promise<QuotaSnapshot | null>;
}

// Why the pool could not hand out an account, shaped for the 429 the client
// is about to receive. retryAfterMs is the earliest known roll-over, or null
// when nothing on record will free up on its own.
export interface Shortfall {
  reason: 'concurrency_saturated' | 'quota_exhausted';
  message: string;
  retryAfterMs: number | null;
}
