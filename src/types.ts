import type { ExternalProvider, ExternalUsage } from './external-usage.js';
import type { RouteColor, RouteConfig } from './routes.js';

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
  // Codex only: the ChatGPT user behind the token. accountId names the
  // workspace and is what the chatgpt-account-id header needs, but every member
  // of a Business/Team workspace shares it, so it cannot tell two members apart.
  userId?: string;
}

export interface TeamAIConfig {
  version: 1;
  proxy: {
    host: string; claudePort: number; codexPort: number; controlPort?: number; clientToken: string;
    // Extra ports to keep answering on, per provider. Clients receive their base
    // URL at startup and cannot be redirected afterwards, so a port change would
    // otherwise strand every open session; listing the old port here keeps those
    // sessions alive. The built-in default port is always included.
    legacyPorts?: Partial<Record<ProviderId, number[]>>;
    // The largest request body relayed, in MB; 512 when absent (see proxy.ts).
    maxBodyMb?: number;
    // What all request bodies held at once may add up to, in MB; 1024 (or
    // maxBodyMb, if larger) when absent (see proxy.ts).
    maxInflightBodyMb?: number;
    // How long a request body may take to arrive, in ms; 300000 when absent,
    // 0 for no limit (see proxy.ts).
    bodyTimeoutMs?: number;
  };
  switchThreshold: number;
  // Codex and Claude keep-warm. The warmer is event-driven; disabling it stops all
  // timers and requests. Kept as one setting so measurement and window starts
  // cannot drift apart.
  warmup?: { enabled?: boolean; claude?: boolean; codex?: boolean };
  maxConcurrentPerAccount: number;
  // How accounts of equal priority are ordered: 'pacing' (default) puts the
  // account furthest behind a straight weekly line first; 'level' the one with
  // the emptiest windows, in 10% steps. See src/pacing.ts.
  routing?: { balance?: 'pacing' | 'level' };
  // Model routes per provider; see src/routes.ts.
  routes?: Partial<Record<ProviderId, RouteConfig[]>>;
  // Usage of other agents installed here (Antigravity, OpenCode Go, Grok,
  // Command Code), shown on the dashboard only. Each provider is shown when detected.
  externalUsage?: { enabled?: boolean; providers?: { antigravity?: boolean; opencodeGo?: boolean; grok?: boolean; commandCode?: boolean }; refreshMs?: number; source?: 'direct' | 'orca' };
  // What the Activity pane shows besides method and path. Both default on.
  activity?: { sessionIds?: boolean; models?: boolean };
  // Codex reset credits ("Full reset" tickets). Off unless turned on; see
  // src/reset-credits.ts for what each key does.
  codexResetCredits?: boolean;
  codexResetCreditsPolicy?: 'fleet' | 'account';
  codexResetCreditsCooldownMs?: number;
  codexResetCreditsReserve?: number;
  codexResetCreditsTimeoutMs?: number;
  codexResetCreditsListRefreshMs?: number;
  // Also spend a ticket when only the short (5-hour) window is used up.
  codexResetCreditsSessionWindow?: boolean;
  // Codex upstream model-capacity retry (enabled by default). Retries keep the
  // selected account unless rotation is explicitly enabled.
  codexCapacityEnabled?: boolean;
  codexCapacityRetryMs?: number;
  codexCapacityPreambleHoldMs?: number;
  codexCapacityRotation?: boolean;
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
  // Codex reset credits on hand, from the usage endpoint only. Absent on a
  // header reading, which must not erase a known count; null when the usage
  // endpoint did not report a usable one.
  resetCredits?: number | null;
}

// One reset credit as the Codex backend lists it, already filtered to the ones
// that can be spent. Times are epoch ms.
export interface ResetCredit { id: string; title: string | null; grantedAt: number | null; expiresAt: number | null }

// The reset-credit ledger kept per Codex account and persisted across
// restarts: an interrupted redemption must still read as possibly spent.
export interface ResetCreditLedger {
  resetCredits?: number | null;
  resetCreditsAt?: number | null;
  resetCreditLastAt?: number | null;
  resetCreditLastOutcome?: string | null;
  resetCreditsConsumed?: number;
  resetCreditResetAt?: number | null;
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

export interface AccountRuntimeState extends ResetCreditLedger {
  usage: number | null;
  resetsAt: number | null;
  windows?: Record<string, QuotaWindow>;
  profile?: SubscriptionProfile | null;
  cooldownUntil: number | null;
  cooldownReason?: 'network' | 'quota' | 'forbidden' | null;
  cooldownAt?: number | null;
  lastUsed: number | null;
  error: string | null;
  // When the quota figures above were last read from upstream, by any route
  // (response headers, the usage endpoint, a probe). The dashboard shows their
  // age so a number nobody has re-read does not pass for a live one.
  measuredAt?: number | null;
  // Window reset timestamps for which the one-per-window start request has
  // already succeeded. Keys are provider window names (5h/7d or
  // primary/secondary), values are the reset timestamps observed then.
  warmupStartWindows?: Record<string, number>;
}

// One relayed request while it is in flight. Written to state.json so the
// dashboard can draw it before it finishes; never carries a body or a token.
export interface ActiveRequest {
  id: string;
  provider: ProviderId;
  providerLabel: string;
  method: string;
  path: string;
  account: string | null;
  startedAt: number;
  // What the client said about itself: its own session id (never one the
  // relay made up) and the model and reasoning effort the body asked for.
  model?: string | null;
  effort?: string | null;
  sessionId?: string | null;
  // The model route the request matched, and whether it ended up outside it.
  route?: string | null;
  routeFallback?: boolean;
  // A stream that delivered its terminal event as response.failed or
  // response.incomplete: the status says 200, the answer is not a whole one.
  streamEnd?: 'failed' | 'incomplete';
  capacityRetries?: number;
}

// The same request once it has ended. status is the HTTP status the client
// got, 499 when the client went away before the response finished, or 'cut' when the upstream stream
// broke after the headers were sent.
export interface RequestSummary {
  provider: ProviderId;
  providerLabel: string;
  method: string;
  path: string;
  account: string | null;
  status: number | string;
  durationMs: number;
  model?: string | null;
  effort?: string | null;
  sessionId?: string | null;
  route?: string | null;
  routeFallback?: boolean;
  streamEnd?: 'failed' | 'incomplete';
  capacityRetries?: number;
}

// message is the readable sentence (and what capture redaction rewrites);
// request is set only on a finished-request line.
export interface ActivityEvent { at: number; message: string; request?: RequestSummary }

export interface PersistedState {
  version: 1;
  accounts: Record<string, AccountRuntimeState>;
  events?: ActivityEvent[];
  active?: ActiveRequest[];
  // The server that wrote this file. The dashboard draws `active` only while
  // that process is alive, so a crash cannot leave requests spinning forever.
  serverPid?: number;
  // Each configured model route and whether its accounts can serve right now,
  // for the dashboard's route markers.
  // The latest usage read for other agents on this machine (display only).
  external?: Partial<Record<ExternalProvider, ExternalUsage>>;
  // Where a new request would go right now, per provider (see
  // AccountPool.preview): the general target, Claude's Fable target, and one
  // per model route. Credential ids.
  next?: Partial<Record<ProviderId, { general: string | null; fable?: string | null; routes?: Record<string, string | null> }>>;
  routes?: Array<{ provider: ProviderId; name: string; color: RouteColor | null; mode: 'prefer' | 'exclusive'; members: Array<{ credentialId: string; usable: boolean }> }>;
  // The warm-up probe shape learned from live traffic, per provider. Without it
  // a restarted proxy falls back to a hardcoded client version that upstream may
  // reject on version grounds, leaving every account unmeasured until real
  // traffic reseeds the template.
  probes?: Partial<Record<ProviderId, ProbeTemplate>>;
}

export interface RuntimeAccount extends StoredAccount, ResetCreditLedger {
  credential: OAuthCredential;
  usage: number | null;
  resetsAt: number | null;
  cooldownUntil: number | null;
  // Why the account is cooling down: a network cooldown benches it for a
  // moment but does not make it a lost home; a quota/forbidden one does.
  cooldownReason: 'network' | 'quota' | 'forbidden' | null;
  cooldownAt?: number | null;
  lastUsed: number | null;
  error: string | null;
  windows: Record<string, QuotaWindow>;
  profile: SubscriptionProfile | null;
  measuredAt: number | null;
  // When the usage request was sent. A response that lands late must not be
  // mistaken for a fresh post-warm reading.
  usageRequestedAt?: number | null;
  warmupStartWindows?: Record<string, number>;
  inflight: number;
  // Memory only: the account was removed from config while a request was
  // still running on it. It finishes that request, takes no new one, and
  // leaves the pool when its last request ends.
  retired?: boolean;
  // Keep-warm state is deliberately process-local; restored quota is never
  // enough to trigger a warm until this process has measured it.
  warmFailures?: number;
  warmRetryAt?: number | null;
  warmGaveUp?: boolean;
  warmGaveUpAt?: number | null;
  warmTransientRetries?: number;
  warmedAt?: number;
  warmConfirmAt?: number | null;
  warmSignature?: string;
  // Set by the pinned relay path when the warm stream ended for a retryable
  // capacity/network reason. It is process-local and never persisted.
  warmTransientFailure?: string | null;
  // Memory only: the redemption running for this account, shared by every
  // caller so a ticket is never spent twice concurrently; and the last list.
  resetCreditPromise?: Promise<import('./reset-credits.js').RedeemResult> | null;
  resetCreditList?: { credits: ResetCredit[]; at: number } | null;
  resetCreditListTriedAt?: number | null;
  resetCreditListFailing?: boolean;
}

export interface FailureDecision {
  // 'quota' benches the whole account; 'model-quota' means only the
  // model-weekly (Fable) budget is spent, so the account still serves every
  // other model and is excluded from this request alone.
  kind: 'quota' | 'model-quota' | 'auth' | 'forbidden' | 'transient' | 'fatal';
  retryAfterMs: number;
}

export interface Provider {
  id: ProviderId;
  label: string;
  upstreamBase: string;
  normalizePath(path: string): string | null;
  // Optional fixed-account path used only by the local warmer.
  pinnedAccount?(path: string): string | null;
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
  // The session, model and effort to show for a request — display only. Kept
  // apart from sessionKey: that one routes, falls back to per-turn handles,
  // and must not change because of what the dashboard wants to show. body is
  // the request body already parsed (null when it is not JSON).
  displayIdentity?(headers: Headers, body: unknown): RequestIdentity;
  defaultProbe?(): ProbeTemplate | null;
  // Cheapest supported model used only to open an otherwise idle quota window.
  startWindowModel?: string;
  captureProbe?(path: string, headers: Headers, body: Buffer, sawModelWeekly: boolean): ProbeTemplate | null;
  probeRequest?(template: ProbeTemplate, credential: OAuthCredential): { url: string; headers: Record<string, string>; body: string };
  fetchProfile?(credential: OAuthCredential): Promise<SubscriptionProfile>;
  // The subscription's own usage read-out — what the client's /usage (Claude)
  // or /status (Codex) screen shows. Unlike a probe it is not a model call, so
  // it spends no quota and can run on a timer across the whole fleet.
  fetchUsage?(credential: OAuthCredential): Promise<QuotaSnapshot | null>;
  // Codex reset credits: list the spendable ones, and spend one. consume
  // returns the raw answer (the backend says no with a 200 and a code) and
  // throws on a timeout or a dropped connection.
  fetchResetCredits?(credential: OAuthCredential): Promise<ResetCredit[]>;
  consumeResetCredit?(credential: OAuthCredential, options: { redeemRequestId: string; creditId?: string; timeoutMs: number }): Promise<{ status: number; body: string }>;
}

export interface RequestIdentity { sessionId: string | null; model: string | null; effort: string | null }

// Why the pool could not hand out an account, shaped for the 429 the client
// is about to receive. retryAfterMs is the earliest known roll-over, or null
// when nothing on record will free up on its own.
export interface Shortfall {
  reason: 'concurrency_saturated' | 'quota_exhausted';
  message: string;
  retryAfterMs: number | null;
}

// Durable binding metadata for pinning sessions to accounts.
export interface StoredSessionBinding {
  sessionId: string;
  provider: ProviderId;
  accountId: string;
  credentialId: string;
  actualAccountId: string;
  boundAt: number;
}
export type StoredSessionBindings = Record<string, StoredSessionBinding>;

