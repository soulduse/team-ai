import type { AccountGroups } from './groups.js';
import { randomUUID } from 'node:crypto';
import { CAPACITY_DEFAULTS, type CodexCapacitySettings } from './codex-capacity.js';
import { comparePacing, sessionWindow, weeklyWindow, type Balance } from './pacing.js';
import { matchRoute, type Route } from './routes.js';
import { adoptClaudeSession, updateSessions, type AdoptOutcome } from './storage.js';
import { candidateOrder, classifyConsume, eligibility, RECHECK_DELAY_MS, RESET_CREDIT_DEFAULTS, RESET_GRACE_MS, type ConsumeOutcome, type RedeemResult, type ResetCreditSettings } from './reset-credits.js';
import type { OAuthCredential, PersistedState, ProbeTemplate, Provider, ProviderId, QuotaSnapshot, QuotaWindow, ResetCredit, ResetCreditLedger, RuntimeAccount, Shortfall, StoredAccount, StoredSessionBinding } from './types.js';

// A quota response that says "0 used, reset exactly one full window from the
// reading" is the upstream shape for a window that has never started. A few
// minutes of slack covers clock skew and the time between the usage request and
// its response, while staying well below the five-minute warm-up cadence.
export const START_WINDOW_TOLERANCE_MS = 5 * 60_000;
const START_WINDOW_MINUTES: Record<ProviderId, Record<string, number>> = {
  codex: { primary: 300, secondary: 10_080 },
  claude: { '5h': 300, '7d': 10_080 },
};

/** True when a provider's quota snapshot still represents an unopened window. */
export function isWindowNotStarted(provider: ProviderId, name: string, window: QuotaWindow | undefined, measuredAt: number | null | undefined, now = Date.now()): boolean {
  const minutes = START_WINDOW_MINUTES[provider][name];
  if (!minutes || !window || window.usage !== 0 || window.resetsAt === null || window.resetsAt === undefined || measuredAt === null || measuredAt === undefined) return false;
  if (window.resetsAt <= now) return false;
  return Math.abs(window.resetsAt - (measuredAt + minutes * 60_000)) <= START_WINDOW_TOLERANCE_MS;
}

// What the static rankings read of an account: enough to rank saved state too.
export type Ranked = Pick<RuntimeAccount, 'usage' | 'resetsAt' | 'windows' | 'inflight'>;

// An empty exclusion set, for judging an account on its own merits rather than
// on what one request has already tried.
const NO_EXCLUSIONS = new Set<string>();

type Judge = (account: RuntimeAccount, excluded: Set<string>, wantsFable: boolean, lastResort: boolean) => boolean;

// Why an adoption named an account that cannot take the conversation.
class AdoptRefusal extends Error {
  constructor(readonly status: 'unknown_account' | 'ambiguous_account' | 'unusable_account', readonly reason?: string) { super(status); }
}
export interface NextTargets { general: string | null; fable?: string | null; routes?: Record<string, string | null> }

export class AccountPool {
  readonly accounts: RuntimeAccount[];
  private affinity = new Map<string, string>();
  private probeTemplate: ProbeTemplate | null = null;
  private probing = false;
  private warmupTries = new Map<string, number>();
  readonly maxWarmupTries = 3;
  private refreshes = new Map<string, Promise<void>>();
  private usageRefreshes = new Map<string, Promise<boolean>>();
  private sweepInFlight = false;
  private usageRead: Promise<unknown> | null = null;
  // Codex capacity retries, shared by the provider's proxy ports.
  codexCapacity: CodexCapacitySettings = { ...CAPACITY_DEFAULTS };
  // Codex reset credits. The server fills these in: the settings from config,
  // saveNow to put state on disk immediately (a redemption is recorded before
  // the call and again after it, never left to the debounced save), and log
  // for the activity pane. The defaults keep the feature inert.
  resetCredits: ResetCreditSettings = RESET_CREDIT_DEFAULTS;
  saveNow: () => Promise<void> = async () => {};
  log: (message: string) => void = () => {};
  private changeListener: ((account: RuntimeAccount) => void) | null = null;
  private deadEndLoggedAt = 0;
  // How accounts of the same priority are ordered: 'pacing' by weekly
  // progress (src/pacing.ts), 'level' by how full they are. The clock is only
  // read for that ordering, so a test can fix it.
  balance: Balance = 'pacing';
  now: () => number = Date.now;

  constructor(readonly provider: Provider, stored: StoredAccount[], credentials: Record<string, OAuthCredential>, state: PersistedState, readonly threshold = 0.98, readonly maxConcurrent = 16, readonly maxSessions = 4096) {
    this.accounts = stored.filter((a) => a.provider === provider.id && credentials[a.credentialId]).map((account) => {
      const saved = state.accounts[account.credentialId];
      // Restore the quota state and active cooldown reason so a usage reading
      // after a restart can distinguish quota recovery from network/forbidden
      // benches. Expired cooldowns are discarded when state is exported.
      // The reset-credit ledger is restored as well: a ticket redeemed (or
      // possibly redeemed) before a restart stays counted.
      const cooldownUntil = saved?.cooldownUntil && saved.cooldownUntil > Date.now() && saved.cooldownReason ? saved.cooldownUntil : null;
      const cooldownReason = cooldownUntil ? (saved?.cooldownReason ?? null) : null;
      return { ...account, credential: credentials[account.credentialId]!, usage: saved?.usage ?? null, resetsAt: saved?.resetsAt ?? null, windows: saved?.windows ?? {}, profile: saved?.profile ?? null, measuredAt: saved?.measuredAt ?? null, warmupStartWindows: saved?.warmupStartWindows ?? {}, cooldownUntil, cooldownReason, cooldownAt: cooldownUntil ? (saved?.cooldownAt ?? null) : null, lastUsed: saved?.lastUsed ?? null, error: null, inflight: 0, ...AccountPool.ledger(saved) };
    });
    // Restore the probe shape learned last run so warm-up and R work on a fresh
    // idle proxy, instead of falling back to a hardcoded client version.
    this.probeTemplate = state.probes?.[provider.id] ?? null;
  }

  static ledger(saved: ResetCreditLedger | undefined): Required<ResetCreditLedger> {
    return { resetCredits: saved?.resetCredits ?? null, resetCreditsAt: saved?.resetCreditsAt ?? null, resetCreditLastAt: saved?.resetCreditLastAt ?? null, resetCreditLastOutcome: saved?.resetCreditLastOutcome ?? null, resetCreditsConsumed: saved?.resetCreditsConsumed ?? 0, resetCreditResetAt: saved?.resetCreditResetAt ?? null };
  }

  // How spent an account is, on the window that actually gates it. Claude's
  // model-weekly (Fable) bucket is the binding one in practice — an account can
  // sit at 50% overall and still refuse the top model at 100% — so it wins when
  // present, falling back to whatever routing window was measured.
  static headroomUsage(account: { usage: number | null; windows: Record<string, { usage: number | null }> }): number | null {
    return AccountPool.bindingWindow(account)?.usage ?? account.usage;
  }

  // The window that decides when this account becomes usable again: Claude's
  // model-weekly (Fable) bucket, or the provider's main window otherwise. Both
  // ranking and the dashboard read the same one so they cannot disagree.
  static bindingWindow(account: { windows: Record<string, { usage: number | null; resetsAt?: number | null }> }): { usage: number | null; resetsAt?: number | null } | undefined {
    return AccountPool.fableWindow(account) ?? AccountPool.generalWindow(account);
  }

  // The model-weekly bucket on its own: the budget only the top model spends.
  static fableWindow(account: { windows: Record<string, { usage: number | null; resetsAt?: number | null }> }): { usage: number | null; resetsAt?: number | null } | undefined {
    return Object.entries(account.windows).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1];
  }

  // The bucket every request spends, Fable or not. This is what gates traffic
  // that does not need the top model, so it is what ranks those requests.
  // Weekly first: Claude's 7d, or the Codex window a week long. Codex calls its
  // 5-hour window primary and its weekly one secondary, so reaching for
  // primary first left the Codex weekly budget out of every ranking.
  static generalWindow(account: { windows: Record<string, { usage: number | null; resetsAt?: number | null; minutes?: number | null }> }): { usage: number | null; resetsAt?: number | null } | undefined {
    return weeklyWindow(account.windows, false) ?? account.windows.primary ?? account.windows.requests;
  }

  // Least-spent first, so both selection and the dashboard agree on what "next"
  // means. Unmeasured accounts sort last rather than first: a null is unknown,
  // not empty, and routing to one on a hunch spends an unknown budget.
  static byHeadroom(a: Ranked, b: Ranked): number {
    const ua = AccountPool.headroomUsage(a); const ub = AccountPool.headroomUsage(b);
    if (ua === null || ub === null) return (ua === null ? 1 : 0) - (ub === null ? 1 : 0);
    if (ua !== ub) return ua - ub;
    // Spent accounts all tie at 100%, and among those the only thing that
    // matters is which one frees up first — a weekly figure of 50% vs 58% says
    // nothing when neither can serve a request today. Rank by the binding
    // window's reset instead: soonest first.
    const ra = AccountPool.bindingWindow(a)?.resetsAt ?? a.resetsAt;
    const rb = AccountPool.bindingWindow(b)?.resetsAt ?? b.resetsAt;
    if (ra !== rb) return (ra ?? Number.MAX_SAFE_INTEGER) - (rb ?? Number.MAX_SAFE_INTEGER);
    return (a.usage ?? 1) - (b.usage ?? 1);
  }

  // Ranking for traffic that does not need the top model: least-spent on the
  // general window, the budget such a request actually consumes. The Fable
  // window says nothing about whether an Opus or Sonnet turn fits, so it only
  // breaks ties (through byHeadroom). Which account to spend first is the
  // priority's call, or a model route's — not a reservation of the pool's own.
  static byGeneralHeadroom(a: Ranked, b: Ranked): number {
    const ua = AccountPool.generalUsage(a); const ub = AccountPool.generalUsage(b);
    if (ua === null || ub === null) return (ua === null ? 1 : 0) - (ub === null ? 1 : 0);
    if (ua !== ub) return ua - ub;
    return AccountPool.byHeadroom(a, b);
  }

  // The Fable window is fully spent (100%): a Fable request can only get a 429
  // there. An unmeasured Fable window is not treated as spent — a null is
  // unknown, and the account may well still serve it.
  static fableSpent(account: Ranked): boolean {
    const usage = AccountPool.fableWindow(account)?.usage;
    return usage !== null && usage !== undefined && usage >= 1;
  }

  // The account has been measured on the shared weekly window and reports no
  // model-weekly (Fable) window at all: a plan without Fable (Claude Pro), so a
  // Fable request has nowhere to go there. An account not measured yet is not
  // judged — the absence of a window it was never asked about means nothing.
  static lacksFable(account: Ranked): boolean {
    return account.windows['7d'] !== undefined && AccountPool.fableWindow(account) === undefined;
  }

  // Whether a Fable request can be served here at all. This is availability,
  // not a reservation: it never moves a non-Fable request anywhere.
  private servesFable(account: Ranked): boolean {
    return !AccountPool.fableSpent(account) && !(this.provider.fableModel && AccountPool.lacksFable(account));
  }

  static generalUsage(account: Ranked): number | null {
    return AccountPool.generalWindow(account)?.usage ?? account.usage;
  }

  // Requests being proxied right now, across every proxy that shares this pool
  // (the main port and its legacy aliases). Admission control reads it before
  // buffering a body, so a flood of local clients cannot pin unbounded memory.
  inFlightProxied = 0;

  // A per-account concurrency cap of 0 means unlimited.
  private atConcurrencyCap(account: RuntimeAccount): boolean {
    return this.maxConcurrent > 0 && account.inflight >= this.maxConcurrent;
  }

  private available(account: RuntimeAccount, excluded: Set<string>, wantsFable = true, lastResort = false): boolean {
    return this.availableIgnoringConcurrency(account, excluded, wantsFable, lastResort) && !this.atConcurrencyCap(account);
  }

  // Everything available() checks except the concurrency slot. Splitting it out
  // lets the pool tell "no slot free right now" (retry) apart from "no account
  // has budget left" (quota) without duplicating the eligibility rules.
  //
  // A Fable request also skips an account whose Fable window is fully spent
  // (100%), or that has no Fable window on a measured account: it can only
  // answer with a 429 there, so trying it just burns a real upstream call and
  // a failover hop before moving on. A non-Fable request still considers it —
  // that budget is exactly what the account has left.
  //
  // The switch threshold (98%) is the point at which the pool prefers another
  // account, not a promise to leave the remainder unused. When nothing else can
  // take the request, `lastResort` admits an account that is over the
  // threshold but not measured as fully spent (<100%): upstream still answers
  // there, and if it does not, its 429 carries the real retry-after that
  // benches the account — better than refusing on a number we chose ourselves.
  private availableIgnoringConcurrency(account: RuntimeAccount, excluded: Set<string>, wantsFable = true, lastResort = false): boolean {
    const now = Date.now();
    if (account.resetsAt && account.resetsAt <= now) { account.usage = null; account.resetsAt = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null; }
    return this.eligible(account, excluded, wantsFable, lastResort, now);
  }

  // The same judgement without touching the account: a window that has
  // rolled over reads as cleared instead of being cleared. For anything that
  // only looks (the dashboard's route and next-account markers).
  private eligible(account: RuntimeAccount, excluded: Set<string>, wantsFable: boolean, lastResort: boolean, now = Date.now()): boolean {
    const rolled = account.resetsAt !== null && account.resetsAt <= now;
    const usage = rolled ? null : account.usage; const cooldownUntil = rolled ? null : account.cooldownUntil;
    const limit = lastResort ? 1 : this.threshold;
    if (!(account.enabled && !account.error && !excluded.has(account.id) && (!cooldownUntil || cooldownUntil <= now) && (usage === null || usage < limit))) return false;
    if (wantsFable && !this.servesFable(account)) return false;
    return true;
  }

  // Group membership is resolved to account ids before a config swap.
  private groups: AccountGroups = Object.create(null);
  setGroups(groups: AccountGroups): void { this.groups = groups; }
  hasGroup(name: string): boolean { return Object.hasOwn(this.groups, name); }
  private groupExclusions(group?: string): Set<string> {
    if (group === undefined) return new Set();
    return new Set(this.accounts.filter((a) => !this.groups[group]?.includes(a.id)).map((a) => a.id));
  }

  // Model routes may warn about missing members; groups reject them instead.
  private routes: Route[] = [];
  private routeFellBack = new Set<string>();
  setRoutes(routes: Route[]): string[] {
    this.routes = routes;
    // A reload can drop a route; forget its fallback note with it.
    for (const name of this.routeFellBack) if (!routes.some((route) => route.name === name)) this.routeFellBack.delete(name);
    return routes.flatMap((route) => route.accounts.filter((ref) => !this.accounts.some((a, i) => AccountPool.names(a, i, ref))).map((ref) => `route ${route.name}: account ${ref} not found — skipped`));
  }
  routeFor(model: string | null | undefined): Route | null { return matchRoute(this.routes, model); }
  get routeList(): readonly Route[] { return this.routes; }
  private static names(account: RuntimeAccount, index: number, ref: string | number): boolean {
    return typeof ref === 'number' ? index === ref : ref === account.label || ref === account.id || ref === account.credentialId;
  }
  isMember(route: Route, account: RuntimeAccount): boolean {
    const index = this.accounts.indexOf(account);
    return route.accounts.some((ref) => AccountPool.names(account, index, ref));
  }
  // An exclusive route narrows the pool by excluding everyone else, so every
  // rule that already honours exclusions — the session pin, ranking, the
  // shortfall wording, failover — stays inside the route on its own.
  private scope(excluded: Set<string>, route: Route | null | undefined): Set<string> {
    if (route?.mode !== 'exclusive') return excluded;
    return new Set([...excluded, ...this.accounts.filter((a) => !this.isMember(route, a)).map((a) => a.id)]);
  }

  // acquire returned nothing but at least one account is otherwise healthy and
  // merely at its concurrency cap: the request should be told to retry, not that
  // the fleet is out of quota.
  saturatedButHealthy(excluded: Set<string> = new Set()): boolean {
    return this.accounts.some((a) => this.availableIgnoringConcurrency(a, excluded, true, true) && this.atConcurrencyCap(a));
  }

  // Why acquire() just came back empty, worded for the client that is about
  // to see a 429. The bare "no account available" hid everything the caller
  // needs to decide what to do: whether it is a slot shortage (retry in a
  // moment) or a budget shortage, whether only the Fable weekly budget is gone
  // (other models still work), and the earliest moment anything rolls over.
  explainShortfall(excludedByRequest: Set<string>, wantsFable: boolean, route?: Route | null, group?: string): Shortfall {
    const label = this.provider.label; const excluded = this.scope(new Set([...excludedByRequest, ...this.groupExclusions(group)]), route);
    if (this.saturatedButHealthy(excluded)) {
      return { reason: 'concurrency_saturated', retryAfterMs: 5_000, message: `Every ${label} account with budget left is at its concurrency cap (${this.maxConcurrent} requests in flight each). Retry in a few seconds.` };
    }
    const now = Date.now();
    const live = this.accounts.filter((a) => a.enabled && !a.error && !excluded.has(a.id));
    const resets: Array<{ at: number; label: string }> = [];
    let fableSpent = 0; let noFable = 0; let overLimit = 0; let coolingDown = 0;
    for (const account of live) {
      const fable = AccountPool.fableWindow(account);
      if (wantsFable && this.provider.fableModel && AccountPool.lacksFable(account)) { noFable++; continue; }
      if (wantsFable && AccountPool.fableSpent(account)) { fableSpent++; if (fable?.resetsAt) resets.push({ at: fable.resetsAt, label: `${account.label} Fable weekly` }); continue; }
      if (account.usage !== null && account.usage >= 1) { overLimit++; if (account.resetsAt) resets.push({ at: account.resetsAt, label: `${account.label} session` }); continue; }
      if (account.cooldownUntil && account.cooldownUntil > now) { coolingDown++; resets.push({ at: account.cooldownUntil, label: `${account.label} cooldown` }); }
    }
    const next = resets.filter((r) => r.at > now).sort((a, b) => a.at - b.at)[0];
    const parts: string[] = [];
    if (fableSpent) parts.push(`${fableSpent} spent the Fable weekly budget`);
    if (noFable) parts.push(`${noFable} without a Fable budget`);
    if (overLimit) parts.push(`${overLimit} used up the session window`);
    if (coolingDown) parts.push(`${coolingDown} cooling down after an upstream rejection`);
    const what = route?.mode === 'exclusive' ? `No ${label} account in route "${route.name}" can serve right now`
      : wantsFable ? `No ${label} account can serve Fable right now` : `No ${label} account has budget left`;
    const detail = parts.length ? ` (${live.length} accounts: ${parts.join(', ')})` : ` (${live.length} accounts)`;
    const when = next ? ` Earliest reset in ${AccountPool.formatDuration(next.at - now)}: ${next.label}.` : '';
    const hint = wantsFable && (fableSpent || noFable) ? ' Other models are still served: switch model or wait.' : '';
    return { reason: 'quota_exhausted', retryAfterMs: next ? next.at - now : null, message: `${what}${detail}.${when}${hint}` };
  }

  static formatDuration(ms: number): string {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ''}`;
    const days = Math.floor(hours / 24);
    return `${days}d${hours % 24 ? `${hours % 24}h` : ''}`;
  }

  // The useful concurrent load this pool can carry: a live account contributes
  // its cap, a disabled one only the requests still draining through it. With an
  // unlimited cap (0) admission control is off, so this is not consulted.
  totalCapacity(): number {
    if (this.maxConcurrent <= 0) return Number.MAX_SAFE_INTEGER;
    return this.accounts.reduce((sum, a) => sum + (a.enabled ? this.maxConcurrent : a.inflight), 0);
  }

  // `wantsFable` says whether this request needs the model-weekly budget. It is
  // read from the request body upstream, so a mixed workload (Claude Code on
  // Opus, another session on Fable) splits across the pool by what each request
  // actually spends rather than all chasing the same window.
  acquire(session: string, requestExcluded = new Set<string>(), wantsFable = true, route: Route | null = null): RuntimeAccount | null {
    const excluded = this.scope(requestExcluded, route);
    // A routed request pins separately, so one session's turns on another
    // model do not drag this pin around (the same reason Fable pins apart).
    const key = AccountPool.affinityKey(session, wantsFable) + (route ? `#route:${route.name}` : '');
    const pinned = this.accounts.find((a) => a.id === this.affinity.get(key));
    // A prefer route ranks its accounts first, and moves a session off an
    // outside account whenever one of its own can take the request.
    const outside = (a: RuntimeAccount) => route?.mode === 'prefer' && !this.isMember(route, a);
    const memberOpen = route?.mode === 'prefer' && this.accounts.some((a) => !outside(a) && this.available(a, excluded, wantsFable));
    // Session affinity is a cache-locality preference, not a claim on the
    // account. Honour it while the account can take the request (and a prefer
    // route has no account of its own open).
    if (pinned && this.available(pinned, excluded, wantsFable) && !(outside(pinned) && memberOpen)) { pinned.inflight++; this.remember(key, pinned.id); this.noteRoute(route, pinned); return pinned; }
    const selected = this.pick(excluded, wantsFable, route, this.availableNow, pinned?.id);
    // A pinned account that is only excluded for this request (a transient
    // failover) or at its concurrency cap is still the session's home: this
    // request spills elsewhere, the pin stays, and the next turn comes back to
    // its warm cache. Only a home that is genuinely gone is replaced.
    if (selected) { selected.inflight++; if (!pinned || !this.isHome(pinned, wantsFable)) this.remember(key, selected.id); this.noteRoute(route, selected); }
    return selected;
  }

  // The ranking acquire() applies after the session pin, shared with
  // preview() so the dashboard's arrow cannot drift from real selection.
  // `judge` decides availability: acquire's clears rolled-over windows as it
  // looks, preview's only looks.
  private pick(excluded: Set<string>, wantsFable: boolean, route: Route | null, judge: Judge, pinned?: string): RuntimeAccount | null {
    const outside = (a: RuntimeAccount) => route?.mode === 'prefer' && !this.isMember(route, a) ? 1 : 0;
    // TeamCodex has one automatic order for Codex accounts: weekly pacing.
    // TeamAI's optional level order remains a Claude setting, but applying it
    // to Codex would rank by the fuller 5-hour/session window and undo the
    // weekly-first policy. Keep the provider-specific decision here so routes,
    // previews and real acquisition cannot drift apart.
    const rank = this.provider.id === 'codex' || this.balance !== 'level'
      ? this.paced(wantsFable, pinned)
      : this.spread(wantsFable);
    // Inside a route: an explicit priority first (lower first, set before
    // unset), then the balance. A Fable request has already left out accounts
    // that cannot serve it; nothing here holds an account back for Fable.
    const ranked = (lastResort: boolean) => this.accounts.filter((a) => judge(a, excluded, wantsFable, lastResort)).sort((a, b) => {
      const routed = outside(a) - outside(b); if (routed) return routed;
      if (a.priority !== null || b.priority !== null) {
        const diff = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
        if (diff !== 0) return diff;
      }
      return rank(a, b);
    });
    // Prefer accounts under the switch threshold; only when none is left does
    // an account over it (but not spent) get the request rather than a 429.
    return ranked(false)[0] || ranked(true)[0] || null;
  }
  private readonly availableNow: Judge = (a, excluded, wantsFable, lastResort) => this.available(a, excluded, wantsFable, lastResort);
  private readonly lookOnly: Judge = (a, excluded, wantsFable, lastResort) => this.eligible(a, excluded, wantsFable, lastResort) && !this.atConcurrencyCap(a);

  // Where a new request — one with no session pin yet — would go right now,
  // without taking a slot, pinning, clearing anything or calling upstream.
  // A preview, not a promise: a pinned session or a request racing this one
  // can land elsewhere. null when nothing could take it (all spent or full).
  preview(wantsFable: boolean, route: Route | null = null): RuntimeAccount | null {
    return this.pick(this.scope(NO_EXCLUSIONS, route), wantsFable, route, this.lookOnly);
  }

  // Initial account selection for a brand-new Claude session.
  pickClaudeInitial(wantsFable: boolean, route: Route | null = null, group?: string): RuntimeAccount | null {
    const excluded = this.scope(this.groupExclusions(group), route);
    return this.pick(excluded, wantsFable, route, this.availableNow);
  }

  // Resolves or atomically binds a Claude session to an account, persisted durably.
  async resolveOrBindClaudeSession(
    sessionId: string,
    wantsFable: boolean,
    route: Route | null = null,
    expectedGroup?: string,
  ): Promise<{
    group?: string;
    account: RuntimeAccount | null;
    status: 'ok' | 'unproven' | 'disabled' | 'removed' | 'cooldown' | 'busy' | 'model_unsupported' | 'no_account' | 'storage_error' | 'credential_mismatch' | 'group_unavailable' | 'group_mismatch';
    cooldownUntil?: number | null;
    cooldownReason?: string | null;
    retryAfterMs?: number | null;
  }> {
    const state = {
      boundId: null as string | null,
      credentialId: undefined as string | undefined,
      actualAccountId: undefined as string | undefined,
      group: undefined as string | undefined,
      outcome: 'ok' as 'ok' | 'unproven' | 'no_account' | 'storage_error' | 'group_unavailable' | 'group_mismatch',
    };

    try {
      await updateSessions(async (bindings, pending, groups) => {
        const existing = bindings[sessionId];
        state.group = existing?.group ?? groups.get(sessionId);
        if (expectedGroup !== undefined && expectedGroup !== state.group) { state.outcome = 'group_mismatch'; return false; }
        if (state.group !== undefined && !this.hasGroup(state.group)) { state.outcome = 'group_unavailable'; return false; }
        if (existing && existing.provider === 'claude') {
          state.boundId = existing.accountId;
          state.credentialId = existing.credentialId;
          state.actualAccountId = existing.actualAccountId;
          return false;
        }

        if (!pending.has(sessionId)) {
          state.outcome = 'unproven';
          return false;
        }

        const initialSelected = this.pickClaudeInitial(wantsFable, route, state.group);
        if (!initialSelected) {
          state.outcome = 'no_account';
          return false;
        }

        const actualAccountId = initialSelected.credential?.accountId;
        if (!actualAccountId) {
          state.outcome = 'no_account';
          return false;
        }

        state.boundId = initialSelected.id;
        state.credentialId = initialSelected.credentialId;
        state.actualAccountId = actualAccountId;

        const binding: StoredSessionBinding = {
          sessionId,
          provider: 'claude',
          ...(state.group === undefined ? {} : { group: state.group }),
          accountId: initialSelected.id,
          credentialId: initialSelected.credentialId,
          actualAccountId,
          boundAt: Date.now(),
        };
        bindings[sessionId] = binding;
      });
    } catch {
      return { account: null, status: 'storage_error' };
    }

    if (state.outcome === 'group_unavailable' || state.outcome === 'group_mismatch') return { account: null, status: state.outcome, group: state.group };
    if (state.outcome === 'storage_error') return { account: null, status: 'storage_error' };
    if (state.outcome === 'unproven') return { account: null, status: 'unproven' };
    if (state.outcome === 'no_account' || !state.boundId) return { account: null, status: 'no_account', group: state.group };

    const boundId = state.boundId;
    const bound = this.accounts.find((a) => a.id === boundId);
    if (!bound || bound.retired) return { account: null, status: 'removed' };

    // Strict credential identity check:
    // Both credentialId and actualAccountId must be present and match the account's real credential!
    if (!state.credentialId || bound.credentialId !== state.credentialId) {
      return { account: null, status: 'credential_mismatch' };
    }
    if (!state.actualAccountId || !bound.credential?.accountId || bound.credential.accountId !== state.actualAccountId) {
      return { account: null, status: 'credential_mismatch' };
    }

    if (state.group !== undefined && !this.groups[state.group]?.includes(bound.id)) return { account: null, status: 'group_unavailable', group: state.group };
    if (!bound.enabled) return { account: null, status: 'disabled' };

    const now = Date.now();
    if (bound.cooldownUntil !== null && bound.cooldownUntil > now) {
      return {
        account: bound,
        group: state.group,
        status: 'cooldown',
        cooldownUntil: bound.cooldownUntil,
        cooldownReason: bound.cooldownReason,
        retryAfterMs: bound.cooldownUntil - now,
      };
    }

    if (this.atConcurrencyCap(bound)) {
      return { account: bound, group: state.group, status: 'busy' };
    }

    if (wantsFable && !this.servesFable(bound)) {
      return { account: bound, group: state.group, status: 'model_unsupported' };
    }

    bound.inflight++;
    bound.lastUsed = now;
    return { account: bound, group: state.group, status: 'ok' };
  }

  // An administrator's adoption of a conversation this relay never registered
  // (one started before it issued IDs): record the named account as that
  // conversation's first account, from this pool's own accounts and
  // credentials. From then on dispatch treats it like any other binding.
  async adoptClaudeSession(sessionId: string, ref: string): Promise<{
    status: AdoptOutcome | 'unknown_account' | 'ambiguous_account' | 'unusable_account' | 'storage_error';
    account?: RuntimeAccount;
    reason?: string;
  }> {
    // Judged inside the session lock, right before the write.
    const find = (): RuntimeAccount => {
      const exact = this.accounts.filter((a) => a.credentialId === ref || a.id === ref);
      const matches = exact.length ? exact : this.accounts.filter((a) => a.label === ref);
      if (!matches.length) throw new AdoptRefusal('unknown_account');
      if (matches.length > 1) throw new AdoptRefusal('ambiguous_account');
      const account = matches[0]!;
      if (account.retired) throw new AdoptRefusal('unusable_account', 'removed');
      if (!account.enabled) throw new AdoptRefusal('unusable_account', 'disabled');
      if (typeof account.credential?.accountId !== 'string' || !account.credential.accountId.trim()) throw new AdoptRefusal('unusable_account', 'its credential has no account id');
      return account;
    };
    let chosen: RuntimeAccount | undefined;
    try {
      const status = await adoptClaudeSession(sessionId, () => {
        const account = find(); chosen = account;
        return { sessionId, provider: 'claude', accountId: account.id, credentialId: account.credentialId, actualAccountId: account.credential.accountId.trim(), boundAt: Date.now() };
      });
      return { status, account: chosen };
    } catch (error) {
      if (error instanceof AdoptRefusal) return { status: error.status, ...(error.reason ? { reason: error.reason } : {}) };
      return { status: 'storage_error' };
    }
  }

  // The preview targets the dashboard marks, by credential id.
  nextTargets(): NextTargets {
    const id = (a: RuntimeAccount | null) => a?.credentialId ?? null;
    const routes = Object.fromEntries(this.routes.map((route) => [route.name, id(this.preview(false, route))]));
    return { general: id(this.preview(false)), ...(this.provider.fableModel ? { fable: id(this.preview(true)) } : {}), ...(this.routes.length ? { routes } : {}) };
  }

  // A prefer route that has to send a request elsewhere says so once, and
  // once more when its own accounts take over again.
  private noteRoute(route: Route | null, account: RuntimeAccount): void {
    if (route?.mode !== 'prefer') return;
    const member = this.isMember(route, account); const fell = this.routeFellBack.has(route.name);
    if (!member && !fell) { this.routeFellBack.add(route.name); this.log(`${this.provider.label} route ${route.name}: no route account available → ${account.label}`); }
    else if (member && fell) { this.routeFellBack.delete(route.name); this.log(`${this.provider.label} route ${route.name}: back on ${account.label}`); }
  }

  // Fable turns and everything else pin separately. One Claude Code session
  // sends both (Haiku classifiers between Fable turns), and a single pin was
  // dragged from the Fable home to the spare on every model switch — after
  // which the next Fable turn was ranked afresh and could land on a third
  // account, cold.
  private static affinityKey(session: string, wantsFable: boolean): string { return wantsFable ? session : `${session}#general`; }

  // Record a pin most-recently-used last, bounded so a server that runs for
  // weeks does not keep an entry for every session it ever saw.
  private remember(key: string, id: string): void {
    this.affinity.delete(key); this.affinity.set(key, id);
    while (this.affinity.size > this.maxSessions) { const oldest = this.affinity.keys().next().value; if (oldest === undefined) break; this.affinity.delete(oldest); }
  }

  // Whether an account is still a valid home for a session, judged without
  // this request's exclusions or the concurrency cap: both are momentary. So
  // is a network cooldown — one connection attempt failed, and the account is
  // benched for two seconds while the request goes elsewhere. Reading that as
  // "the home is gone" moved sessions off perfectly good accounts whenever a
  // blip landed between two turns more than two seconds apart, cold-starting
  // the next turn for nothing. Only a quota or forbidden cooldown evicts.
  private isHome(account: RuntimeAccount, wantsFable: boolean): boolean {
    if (account.cooldownReason === 'network') {
      return account.enabled && !account.error && (account.usage === null || account.usage < this.threshold) && !(wantsFable && !this.servesFable(account));
    }
    return this.availableIgnoringConcurrency(account, NO_EXCLUSIONS, wantsFable);
  }

  get pinnedSessions(): number { return this.affinity.size; }

  // The 'level' order for a new session (routing.balance: "level"; the
  // default is paced() below). The static rankings compare exact
  // usage, which herds every new session onto whichever account is a point
  // lower this hour (51% vs 52%) until its weekly figure creeps past the next
  // one — a number that moves a tenth of a percent per request. Meanwhile the
  // window that actually gates the account next is often the 5-hour session
  // window, which the weekly figure never sees, so one account fills its
  // session window alone while seven sit at 0%.
  //
  // So: compare load on the fuller of the weekly and session windows in 10%
  // steps, and inside a step prefer the account with fewer requests in flight. Only then fall back to the exact ranking, so both the
  // dashboard's order and the fleet-wide preference still hold.
  private spread(wantsFable: boolean): (a: RuntimeAccount, b: RuntimeAccount) => number { return AccountPool.levelOrder(wantsFable); }

  // spread() on its own, for anything that ranks without a pool: the
  // dashboard's 'level' order compares saved state through this same function.
  static levelOrder(wantsFable: boolean): (a: Ranked, b: Ranked) => number {
    const exact = wantsFable ? AccountPool.byHeadroom : AccountPool.byGeneralHeadroom;
    const bucket = (a: Ranked) => { const load = AccountPool.loadUsage(a, wantsFable); return load === null ? Number.MAX_SAFE_INTEGER : Math.floor(load * 10); };
    return (a, b) => bucket(a) - bucket(b) || a.inflight - b.inflight || exact(a, b);
  }

  // The 'pacing' order: weekly progress (comparePacing). An account whose
  // 5-hour window is at the switch threshold never gets here — routingUsage is the fuller of the two windows,
  // so eligible() has already set it aside — and being behind on the week
  // cannot pull a request onto an account about to refuse it.
  private paced(wantsFable: boolean, pinned?: string): (a: RuntimeAccount, b: RuntimeAccount) => number {
    const now = this.now();
    // Accounts that tie on every pacing key (nothing measured, or windows with
    // no reset) fall back to the static ranking rather than config order.
    const exact = wantsFable ? AccountPool.byHeadroom : AccountPool.byGeneralHeadroom;
    return (a, b) => comparePacing(a, b, wantsFable, now, pinned) || exact(a, b);
  }

  // How full the account is on whichever window will gate its next request:
  // the budget this kind of request spends, or the 5-hour session window,
  // whichever is fuller. Null when neither has been measured.
  static loadUsage(account: Ranked, wantsFable: boolean): number | null {
    const budget = wantsFable ? AccountPool.headroomUsage(account) : AccountPool.generalUsage(account);
    const session = sessionWindow(account.windows)?.usage ?? null;
    if (budget === null && session === null) return null;
    return Math.max(budget ?? 0, session ?? 0);
  }

  release(account: RuntimeAccount): void {
    account.inflight = Math.max(0, account.inflight - 1); account.lastUsed = Date.now();
    // A removed account leaves once the request it was kept for has ended.
    if (account.retired && account.inflight === 0) { const at = this.accounts.indexOf(account); if (at >= 0) this.accounts.splice(at, 1); this.forget(account.id); }
  }
  private forget(id: string): void { for (const [session, held] of this.affinity) if (held === id) this.affinity.delete(session); }
  updateQuota(account: RuntimeAccount, headers: Headers, body?: string): void {
    const quota = this.provider.readQuota(headers, body);
    if (quota) this.applyQuota(account, quota);
    // A live plan header is fresher than the one decoded from the token at
    // login, so a plan change shows up without re-authenticating.
    const plan = headers.get('x-codex-plan-type');
    if (plan && account.profile && account.profile.rateLimitTier !== plan) account.profile = { ...account.profile, rateLimitTier: plan };
  }
  private applyQuota(account: RuntimeAccount, quota: QuotaSnapshot, source: 'headers' | 'usage' = 'headers'): void {
    const now = this.now();
    const previousMeasuredAt = account.measuredAt;
    this.applyCreditCount(account, quota, now);
    // Shortly after a reset, a usage read may still describe the windows as
    // they were before it: let it lower usage, never raise it.
    if (source === 'usage' && this.inResetGrace(account, now)) {
      const windows = Object.fromEntries(Object.entries(quota.windows).map(([name, w]) => {
        const held = account.windows[name]?.usage;
        return [name, { ...w, usage: held === null || held === undefined || w.usage === null ? w.usage : Math.min(held, w.usage) }];
      }));
      const usage = account.usage === null || quota.routingUsage === null ? quota.routingUsage : Math.min(account.usage, quota.routingUsage);
      account.usage = usage; account.resetsAt = quota.routingResetsAt; account.windows = { ...account.windows, ...windows }; account.measuredAt = now;
      this.clearRecoveredQuotaCooldown(account, quota, now, previousMeasuredAt, source);
      this.changeListener?.(account);
      return;
    }
    account.usage = quota.routingUsage; account.resetsAt = quota.routingResetsAt; account.windows = { ...account.windows, ...quota.windows }; account.measuredAt = now;
    this.clearRecoveredQuotaCooldown(account, quota, now, previousMeasuredAt, source);
    this.changeListener?.(account);
  }

  private clearRecoveredQuotaCooldown(account: RuntimeAccount, quota: QuotaSnapshot, measuredAt: number, previousMeasuredAt: number | null, source: 'headers' | 'usage'): void {
    if (source !== 'usage' || account.cooldownReason !== 'quota' || account.cooldownUntil === null || account.cooldownUntil <= measuredAt) return;
    const measuredAfterCooldown = account.cooldownAt === null || account.cooldownAt === undefined ? previousMeasuredAt !== null && previousMeasuredAt <= measuredAt : measuredAt >= account.cooldownAt;
    if (!measuredAfterCooldown) return;
    const windows = Object.values(quota.windows);
    if (windows.length === 0 || windows.some((window) => window.usage === null || window.usage === undefined || window.usage >= 1)) return;
    account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null;
  }

  /** Listen for usage/window changes so the event-driven warmer can re-plan. */
  setChangeListener(listener: ((account: RuntimeAccount) => void) | null): void { this.changeListener = listener; }

  // Only the usage endpoint reports a count; a header reading leaves it be.
  private applyCreditCount(account: RuntimeAccount, quota: QuotaSnapshot, now: number): void {
    if (typeof quota.resetCredits === 'number') { account.resetCredits = quota.resetCredits; account.resetCreditsAt = now; }
  }

  private inResetGrace(account: RuntimeAccount, now = Date.now()): boolean {
    return account.resetCreditResetAt !== null && account.resetCreditResetAt !== undefined && now - account.resetCreditResetAt < RESET_GRACE_MS;
  }

  // updateQuota for a relayed response, fenced against a reset credit: a
  // response to a request sent before the reset says nothing about the
  // windows after it ('stale'), and for a short while after the reset an
  // ordinary response's figures are held back too ('held'). A 429 sent after
  // the reset is always applied — it is the proof the reset did not take.
  observeResponse(account: RuntimeAccount, headers: Headers, dispatchedAt: number, status: number): 'stale' | 'held' | 'applied' {
    const resetAt = account.resetCreditResetAt;
    if (resetAt !== null && resetAt !== undefined && dispatchedAt < resetAt) return 'stale';
    if (status !== 429 && this.inResetGrace(account)) return 'held';
    this.updateQuota(account, headers);
    return 'applied';
  }
  cooldown(account: RuntimeAccount, ms: number, reason: 'network' | 'quota' | 'forbidden' = 'quota'): void { account.cooldownAt = this.now(); account.cooldownUntil = account.cooldownAt + Math.max(1_000, ms); account.cooldownReason = reason; }

  // Upstream refused this account for the top model only. Record the Fable
  // window as spent rather than cooling the account down: every other model is
  // still served from here, and the window carries its own reset so routing
  // recovers on its own once it rolls over.
  markFableSpent(account: RuntimeAccount, retryAfterMs: number): void {
    const existing = AccountPool.fableWindow(account);
    const resetsAt = existing?.resetsAt ?? (retryAfterMs > 0 ? Date.now() + retryAfterMs : null);
    const name = Object.keys(account.windows).find((n) => /^7d_[a-z0-9]+$/i.test(n)) ?? '7d_oi';
    account.windows = { ...account.windows, [name]: { usage: 1, resetsAt } };
  }
  fail(account: RuntimeAccount, message: string): void { account.error = message; }

  async refresh(account: RuntimeAccount, force = false): Promise<void> {
    if (!force && account.credential.expiresAt && account.credential.expiresAt > this.now() + 5 * 60_000) return;
    const existing = this.refreshes.get(account.id);
    if (existing) return existing;
    const promise = this.provider.refresh(account.credential).then((next) => { account.credential = next; account.error = null; }).finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, promise);
    return promise;
  }

  // Keep idle accounts' refresh-token chains rotating. Ordinary traffic sticks
  // to a few accounts and warm-up deliberately never refreshes, so an account
  // no one has used can sit until its access token lapses — and once the
  // refresh token stops rotating, upstream may invalidate it and the account is
  // lost the next time it is actually needed. This sweep refreshes any account
  // whose token is expiring or whose last attempt errored.
  //
  // Sequential on purpose: after a long downtime the whole fleet can be due at
  // once, and firing every refresh together would burst the token endpoint into
  // a rate limit that errors accounts that were merely idle. One at a time.
  async refreshLapsed(): Promise<{ healed: number; failed: number }> {
    if (this.sweepInFlight) return { healed: 0, failed: 0 };
    this.sweepInFlight = true;
    try {
      const now = Date.now();
      const due = this.accounts.filter((a) => !a.retired && a.credential.refreshToken
        && (a.error !== null || a.credential.expiresAt === null || a.credential.expiresAt < now + 5 * 60_000));
      let healed = 0; let failed = 0;
      for (const account of due) {
        // Force when the account errored or its expiry is unknown: refresh()'s
        // own gate skips a token that still looks valid, but an errored account
        // needs the attempt to heal and a null expiry never trips the gate at
        // all. A merely-expiring token passes the gate on its own.
        //
        // A refusal is recorded on the account, not swallowed: this sweep used
        // to report every attempt as "refreshed" while two dead tokens stayed
        // expired for a day, showing as active the whole time. An account whose
        // token cannot be renewed cannot serve, so it is benched here until a
        // later sweep — or a re-login adopted by adoptCredentials — heals it.
        try { await this.refresh(account, account.error !== null || account.credential.expiresAt === null); healed++; }
        catch (error) { failed++; account.error = `token refresh failed: ${(error as Error).message}`; }
      }
      return { healed, failed };
    } finally {
      this.sweepInFlight = false;
    }
  }

  // A rolled-over window keeps its stale numbers until something looks, and
  // warm-up only targets unmeasured accounts — so clear what upstream has
  // already reset, which is what makes an idle proxy re-measure after a reset
  // instead of showing last week's figures forever.
  sweepExpired(): number {
    const now = this.now();
    let swept = 0;
    for (const account of this.accounts) {
      let changed = false;
      for (const [name, window] of Object.entries(account.windows)) {
        if (window.resetsAt && window.resetsAt <= now) { delete account.windows[name]; delete account.warmupStartWindows?.[name]; changed = true; }
      }
      if (account.resetsAt && account.resetsAt <= now) { account.usage = null; account.resetsAt = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null; changed = true; }
      if (changed) { this.warmupTries.delete(account.credentialId); swept++; }
    }
    return swept;
  }

  // Re-read quota from the provider's usage endpoint for every account whose
  // last reading is older than maxAgeMs. Response headers only ever update the
  // accounts this proxy routes to, so an account spent through another client
  // on the same subscription kept its old figure until someone pressed R. The
  // endpoint is not a model call and spends no quota, which is what makes a
  // fleet-wide timer affordable where a probe was not. Busy accounts are read
  // too: this takes no request slot. Returns the ids it measured, so a caller
  // can fall back to probing only the rest.
  //
  // A read already running is waited out rather than skipped: R pressed during
  // a timer read would otherwise see nothing measured and probe the whole fleet.
  async refreshUsage(maxAgeMs: number): Promise<Set<string>> {
    const measured = new Set<string>();
    if (!this.provider.fetchUsage) return measured;
    while (this.usageRead) await this.usageRead;
    const read = (async () => {
      const cutoff = this.now() - maxAgeMs;
      // With reset credits on, an account whose ticket count has gone stale is
      // read too: busy accounts stay fresh through headers, which never carry
      // the count, and would otherwise never have one.
      const countsDue = (a: RuntimeAccount) => (this.provider.id === 'codex' ? this.resetCredits.enabled : this.resetCredits.claudeEnabled) && Boolean(this.provider.consumeResetCredit) && (a.resetCreditsAt ?? 0) <= cutoff;
      const due = this.accounts.filter((a) => a.enabled && !a.retired && !a.error && ((a.measuredAt ?? 0) <= cutoff || countsDue(a) || (a.cooldownReason === 'quota' && (a.cooldownUntil ?? 0) > this.now())));
      await Promise.all(due.map(async (account) => {
        try {
          await this.refresh(account);
          const started = this.now();
          account.usageRequestedAt = started;
          const quota = await this.provider.fetchUsage!(account.credential);
          // A proxied response may have landed while this read was in flight;
          // its headers are newer than this snapshot, so they are kept.
          if (quota && (account.measuredAt ?? 0) < started) { this.applyQuota(account, quota, 'usage'); measured.add(account.id); }
          else if (quota) { this.applyCreditCount(account, quota, this.now()); measured.add(account.id); }
        } catch { /* a failed read leaves the account to the probe fallback */ }
      }));
    })();
    this.usageRead = read;
    try { await read; } finally { this.usageRead = null; }
    return measured;
  }

  /** Refresh one account immediately; used by the warmer at reset+10s and by the periodic usage refresher. */
  async refreshUsageAccount(account: RuntimeAccount): Promise<boolean> {
    if (!this.provider.fetchUsage || !this.accounts.includes(account) || !account.enabled || account.retired) return false;
    if (account.error && !account.credential.refreshToken) return false;
    const existing = this.usageRefreshes.get(account.credentialId);
    if (existing) return existing;
    const run = (async () => {
      await this.refresh(account, account.error !== null);
      if (account.error || !account.enabled || account.retired || !this.accounts.includes(account)) return false;
      const requestedAt = this.now();
      account.usageRequestedAt = requestedAt;
      const quota = await this.provider.fetchUsage!(account.credential);
      if (!quota || !account.enabled || account.retired || !this.accounts.includes(account)) return false;
      if ((account.measuredAt ?? 0) <= requestedAt) this.applyQuota(account, quota, 'usage');
      else this.applyCreditCount(account, quota, this.now());
      return true;
    })().finally(() => this.usageRefreshes.delete(account.credentialId));
    this.usageRefreshes.set(account.credentialId, run);
    return run;
  }

  // Accounts worth a background probe: idle, not errored, and still without a
  // reading. The attempt cap stops an account whose upstream never reports
  // quota from being probed on every tick forever; it is cleared whenever a
  // window is swept, since a fresh period is a fresh reason to look.
  private warmupCandidates(): RuntimeAccount[] {
    return this.accounts.filter((account) => account.inflight === 0 && !account.error && account.usage === null
      && (this.warmupTries.get(account.credentialId) ?? 0) < this.maxWarmupTries);
  }

  // Background pass: measure only what is unmeasured, and top up a Fable window
  // that ordinary traffic cannot fill. Unlike probeAll (the TUI's R) this never
  // re-probes an account that already has numbers, so an idle proxy costs one
  // request per account per reset period rather than one per tick.
  async warmup(startWindows = true): Promise<number> {
    if (!this.probeTemplate && this.provider.defaultProbe) this.probeTemplate = this.provider.defaultProbe();
    if (!this.hasProbe() || this.probing) return 0;
    this.probing = true;
    try {
      const candidates = this.warmupCandidates();
      let measured = 0;
      if (candidates.length) {
        await Promise.all(candidates.map((a) => this.refresh(a).catch(() => { /* surfaced via error */ })));
        const results = await Promise.all(candidates.filter((a) => !a.error && a.inflight === 0).map(async (account) => {
          const ok = await this.probeOne(account);
          if (ok) this.warmupTries.delete(account.credentialId);
          else this.warmupTries.set(account.credentialId, (this.warmupTries.get(account.credentialId) ?? 0) + 1);
          return ok;
        }));
        measured = results.filter(Boolean).length;
      }
      // A zero-used window whose reset is one full span after measuredAt has
      // not started upstream. Send one tiny request per account, sequentially,
      // so opening a fleet does not create a burst. The reset timestamp is
      // persisted only after a quota-bearing success; failures consume the
      // same three-attempt budget as ordinary warm-up probes.
      if (startWindows) {
        const starts = this.accounts.flatMap((account) => Object.entries(account.windows)
          .filter(([name, window]) => isWindowNotStarted(this.provider.id, name, window, account.measuredAt, this.now()))
          .filter(([name, window]) => {
            const recorded = account.warmupStartWindows?.[name];
            return recorded === undefined || Math.abs(recorded - (window.resetsAt ?? 0)) > START_WINDOW_TOLERANCE_MS;
          })
          .map(([name, window]) => ({ account, name, resetAt: window.resetsAt! })));
        const byAccount = new Map<string, Array<{ name: string; resetAt: number }>>();
        for (const start of starts) { const list = byAccount.get(start.account.id) ?? []; list.push({ name: start.name, resetAt: start.resetAt }); byAccount.set(start.account.id, list); }
        for (const account of this.accounts) {
          const windows = byAccount.get(account.id);
          if (!windows || account.inflight !== 0 || account.error) continue;
          await this.refresh(account).catch(() => { /* surfaced via error */ });
          if (account.error || account.inflight !== 0) continue;
          const key = `start:${account.credentialId}`;
          if ((this.warmupTries.get(key) ?? 0) >= this.maxWarmupTries) continue;
          const ok = await this.probeOne(account, this.provider.startWindowModel, windows.map((window) => window.name));
          if (ok) {
            account.warmupStartWindows ??= {};
            // One request may open only one of several reported buckets. Keep
            // a marker for each bucket independently so an unopened weekly
            // window is still retried after the session window succeeds.
            const started = windows.filter((window) => !isWindowNotStarted(this.provider.id, window.name, account.windows[window.name], account.measuredAt, this.now()));
            for (const window of started) account.warmupStartWindows[window.name] = window.resetAt;
            this.warmupTries.delete(key);
          } else this.warmupTries.set(key, (this.warmupTries.get(key) ?? 0) + 1);
        }
      }
      const fableModel = this.provider.fableModel;
      if (fableModel) {
        const missing = this.accounts.filter((a) => a.inflight === 0 && !a.error && a.usage !== null
          && !Object.keys(a.windows).some((name) => /^7d_[a-z0-9]+$/i.test(name))
          && (this.warmupTries.get(`fable:${a.credentialId}`) ?? 0) < this.maxWarmupTries);
        if (missing.length) {
          await Promise.all(missing.map(async (account) => {
            const ok = await this.probeOne(account, fableModel);
            const key = `fable:${account.credentialId}`;
            if (ok && Object.keys(account.windows).some((name) => /^7d_[a-z0-9]+$/i.test(name))) this.warmupTries.delete(key);
            else this.warmupTries.set(key, (this.warmupTries.get(key) ?? 0) + 1);
          }));
        }
      }
      return measured;
    } finally { this.probing = false; }
  }

  // Absorb config/credential changes made by another process (the TUI writes
  // accounts to disk, the server holds the pools) without a restart. Live
  // runtime state — usage, windows, cooldowns, inflight, affinity, the reset
  // ledger — is preserved for accounts that stay; only genuinely new ones are
  // built fresh. A removed account with a request in flight is retired rather
  // than dropped: that response runs to the end on it, no new request picks
  // it, and release() takes it out of the pool after its last one.
  sync(stored: StoredAccount[], credentials: Record<string, OAuthCredential>): { added: number; removed: number; retired: number } {
    const wanted = stored.filter((a) => a.provider === this.provider.id && credentials[a.credentialId]);
    const byId = new Map(this.accounts.map((a) => [a.credentialId, a]));
    const keep = new Set(wanted.map((a) => a.credentialId));
    let added = 0;
    const next: RuntimeAccount[] = [];
    for (const account of wanted) {
      const live = byId.get(account.credentialId);
      if (live) {
        // Config fields may have been edited (label, enabled, priority); runtime
        // fields and the possibly-refreshed credential stay as they are. An
        // account removed and added back before its request ended is live again.
        next.push(Object.assign(live, { id: account.id, label: account.label, enabled: account.enabled, priority: account.priority, retired: false }));
      } else {
        added++;
        next.push({ ...account, credential: credentials[account.credentialId]!, usage: null, resetsAt: null, windows: {}, profile: null, measuredAt: null, warmupStartWindows: {}, cooldownUntil: null, cooldownReason: null, cooldownAt: null, lastUsed: null, error: null, inflight: 0, ...AccountPool.ledger(undefined) });
      }
    }
    const dropped = this.accounts.filter((a) => !keep.has(a.credentialId));
    const busy = dropped.filter((a) => a.inflight > 0);
    // Disabled as well as retired, so every rule that skips a disabled account
    // (selection, pins, failover, capacity, the dashboard markers) skips it.
    for (const account of busy) { account.retired = true; account.enabled = false; next.push(account); }
    this.accounts.length = 0; this.accounts.push(...next);
    for (const [session, id] of this.affinity) if (!this.accounts.some((a) => a.id === id && !a.retired)) this.affinity.delete(session);
    return { added, removed: dropped.length - busy.length, retired: busy.length };
  }

  // Commit a known-accepted request shape, captured from a real 2xx response.
  // Only an upstream success proves the shape is servable, so quota probes can
  // replay it against other accounts instead of guessing a payload (a guessed
  // shape gets 429'd by Anthropic for OAuth credentials and measures nothing).
  // A template that elicited the model-weekly (Fable) window wins over one that
  // did not, so the dashboard can fill that column too.
  commitProbe(path: string, headers: Headers, body: Buffer, responseHeaders: Headers): void {
    if (!this.provider.captureProbe) return;
    const sawModelWeekly = [...responseHeaders].some(([key]) => /ratelimit-unified-7d_[a-z0-9]+-utilization$/i.test(key));
    if (this.probeTemplate && (this.probeTemplate.elicitsModelWeekly || !sawModelWeekly)) return;
    const candidate = this.provider.captureProbe(path, headers, body, sawModelWeekly);
    if (candidate) this.probeTemplate = candidate;
  }

  // A quota-bearing rejection is proof of shape too: upstream parsed the request
  // and answered with this account's authoritative numbers. Without this, a
  // fleet whose accounts are ALL exhausted can never commit a template from a
  // 2xx, so `R` would report nothing to measure for exactly the fleet whose
  // numbers the user most wants to see.
  commitProbeFromQuotaRejection(path: string, headers: Headers, body: Buffer, responseHeaders: Headers): void {
    if (!this.provider.captureProbe || this.probeTemplate) return;
    if (!this.provider.readQuota(responseHeaders)) return;
    const candidate = this.provider.captureProbe(path, headers, body, false);
    if (candidate) this.probeTemplate = candidate;
  }

  hasProbe(): boolean { return this.probeTemplate !== null && Boolean(this.provider.probeRequest); }
  getProbeTemplate(): ProbeTemplate | null { return this.probeTemplate ?? this.provider.defaultProbe?.() ?? null; }

  // Force a fleet-wide quota re-measure (TUI 'R'). The usage endpoint reads
  // every account first, busy ones included, at no quota cost; only accounts it
  // could not read fall back to replaying the committed probe template. An
  // exhausted account's 429 still carries authoritative quota headers, so the
  // fallback covers throttled accounts too. Tokens are refreshed first — an
  // idle account past its token lifetime is the main reason a read would
  // otherwise measure nothing. Returns { targets, measured } so the TUI can
  // report honest M/N.
  async probeAll(): Promise<{ targets: number; measured: number }> {
    this.warmupTries.clear();
    const viaUsage = await this.refreshUsage(0);
    // Fall back to the shape this provider knows its client sends. A pool whose
    // accounts are ALL exhausted never serves a request, so it can never capture
    // a template from live traffic — and would stay permanently unmeasurable,
    // which is exactly when the numbers matter most.
    if (!this.probeTemplate && this.provider.defaultProbe) this.probeTemplate = this.provider.defaultProbe();
    if (!this.hasProbe() || this.probing) return { targets: this.accounts.length, measured: viaUsage.size };
    this.probing = true;
    try {
      const targets = this.accounts.filter((a) => a.inflight === 0);
      await Promise.all(targets.map((a) => this.refresh(a).catch(() => { /* surfaced below */ })));
      // Re-check inflight after the await: a live request may have been routed
      // to an account while tokens were refreshing, and a probe does not go
      // through acquire/release, so probing it would exceed maxConcurrent.
      const alive = targets.filter((a) => !a.error && a.inflight === 0);
      const results = await Promise.all(alive.filter((a) => !viaUsage.has(a.id)).map((a) => this.probeOne(a)));
      // Model-weekly (Fable) top-up: that window only appears on responses to
      // Fable-tier requests, so an account measured by an ordinary probe keeps
      // a blank Fbl bar forever. Re-probe those once with the Fable model.
      const fableModel = this.provider.fableModel;
      if (fableModel) {
        const missing = alive.filter((a) => !Object.keys(a.windows).some((name) => /^7d_[a-z0-9]+$/i.test(name)));
        if (missing.length) await Promise.all(missing.map((a) => this.probeOne(a, fableModel)));
      }
      return { targets: this.accounts.length, measured: viaUsage.size + results.filter(Boolean).length };
    } finally { this.probing = false; }
  }

  private async probeOne(account: RuntimeAccount, modelOverride?: string, startWindows: string[] = []): Promise<boolean> {
    const template = this.probeTemplate;
    if (!template || !this.provider.probeRequest) return false;
    try {
      const shape = this.provider.probeRequest(modelOverride ? { ...template, model: modelOverride } : template, account.credential);
      const response = await fetch(shape.url, { method: 'POST', headers: shape.headers, body: shape.body, signal: AbortSignal.timeout(30_000) });
      // Codex sends an SSE body without a content-type. Reading only the
      // response headers and cancelling here can stop generation before the
      // upstream commits quota for the request. Drain every response, and let
      // the abort signal cap a stream that never reaches its terminal event.
      const text = await response.text();
      // "Measured" means this probe actually carried quota headers — not merely
      // that the account already had a number from before. Ask the provider what
      // it read, so a header-less response (a 400/404, an upstream hiccup) is
      // reported as unmeasured instead of inflating the M/N the TUI shows.
      const quota = this.provider.readQuota(response.headers, text);
      let observedQuota = quota !== null;
      if (quota) this.applyQuota(account, quota);
      // A successful HTTP response is not proof that a window started. The
      // usage endpoint is the authoritative post-request reading; when it is
      // available, read it after the stream has ended and require one of the
      // target windows to no longer have the exact unopened shape.
      if (startWindows.length && this.provider.fetchUsage) {
        try {
          const measured = await this.provider.fetchUsage(account.credential);
          if (measured) { this.applyQuota(account, measured, 'usage'); observedQuota = true; }
        } catch { /* retain the response-header reading as a fallback */ }
      }
      if (response.ok) { account.error = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null; }
      // A rejection that only names the model-weekly window says the account is
      // spent for the top model, not unusable: an ordinary probe (the default
      // model) still succeeds here. Clearing the bench on that reading is what
      // lets R recover an account parked for days by a Fable-only 429 — the
      // cooldown it was given was the weekly retry-after, which no other model
      // has to wait for.
      else if (!modelOverride && this.provider.classifyFailure(response.status, response.headers, text).kind === 'model-quota') {
        account.error = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null;
      }
      if (startWindows.length) {
        const opened = startWindows.some((name) => !isWindowNotStarted(this.provider.id, name, account.windows[name], account.measuredAt, this.now()));
        return opened && observedQuota;
      }
      return observedQuota;
    } catch { return false; }
  }

  // Take over any credential on disk that is newer than the one held here.
  // A re-login runs in the TUI process and writes straight to credentials.json;
  // this server never re-read that file for an account it already had, and
  // worse, its next save wrote the stale token back over the fresh one — so a
  // re-login for an existing account silently did nothing while the server
  // ran. Newer means a later expiry: a token the server refreshed itself is
  // newer than disk and stays; a token the user just minted is newer than
  // memory and wins. Adopting one clears the account's error, since the whole
  // point of the re-login was to replace a token that could not be renewed.
  adoptCredentials(latest: Record<string, OAuthCredential>): number {
    let adopted = 0;
    for (const account of this.accounts) {
      const fresh = latest[account.credentialId];
      if (!fresh || fresh.expiresAt === null || fresh.accessToken === account.credential.accessToken) continue;
      if (account.credential.expiresAt !== null && fresh.expiresAt <= account.credential.expiresAt) continue;
      account.credential = fresh; account.error = null; adopted++;
    }
    return adopted;
  }

  async refreshProfiles(): Promise<number> {
    if (!this.provider.fetchProfile) return 0;
    let updated = 0;
    for (const account of this.accounts) {
      try {
        await this.refresh(account);
        const fetched = await this.provider.fetchProfile(account.credential);
        // Response headers carry fresher facts than a token decode (and some,
        // like the active limit tier, are header-only), so a refresh must not
        // blank what live traffic already taught us.
        account.profile = { ...fetched, orgType: fetched.orgType ?? account.profile?.orgType ?? null, rateLimitTier: fetched.rateLimitTier ?? account.profile?.rateLimitTier ?? null };
        updated++;
      } catch { /* retain last known profile */ }
    }
    return updated;
  }

  // Take a slot on one particular account, for a retry that must go back to
  // the account a reset credit was just spent on.
  claim(account: RuntimeAccount, excluded: Set<string>, wantsFable = false): boolean {
    if (!this.available(account, excluded, wantsFable, true)) return false;
    account.inflight++; return true;
  }

  private async saveSafely(): Promise<boolean> {
    try { await this.saveNow(); return true; } catch { return false; }
  }

  // Spend one reset credit on this account. Only one redemption runs per
  // account; a second caller (another request, or the operator) shares its
  // result instead of starting another. With enforce, the account must pass
  // eligibility() first; the operator's manual path skips that check.
  redeemResetCredit(account: RuntimeAccount, reason: string, options: { enforce?: boolean; creditId?: string; recheck?: boolean } = {}): Promise<RedeemResult> {
    if (account.resetCreditPromise) return account.resetCreditPromise;
    const skipped = (why: string): Promise<RedeemResult> => Promise.resolve({ kind: 'no-spend', code: why, windowsReset: null, error: null, skipped: true, reason });
    if (!this.provider.consumeResetCredit) return skipped('unsupported');
    if (options.enforce) { const why = eligibility(account, this.resetCredits, this.provider.id); if (why !== 'ok') return skipped(why); }
    const label = this.provider.label;
    const run = (async (): Promise<RedeemResult> => {
      try { await this.refresh(account); } catch (error) {
        account.resetCreditLastAt = Date.now(); account.resetCreditLastOutcome = 'token_refresh_failed'; await this.saveSafely();
        this.log(`${label} reset credit on "${account.label}" (${reason}) skipped — credential unusable (${(error as Error).message.slice(0, 120)})`);
        return { kind: 'no-spend', code: 'token_refresh_failed', windowsReset: null, error: null, skipped: true, reason };
      }
      // On disk before the call: if the process dies between here and the
      // answer, the restart finds 'pending' and will not spend another.
      account.resetCreditLastAt = Date.now(); account.resetCreditLastOutcome = 'pending';
      if (!(await this.saveSafely())) {
        account.resetCreditLastOutcome = 'save_failed';
        this.log(`${label} reset credit NOT applied on "${account.label}" (${reason}): state could not be saved first`);
        return { kind: 'no-spend', code: 'save_failed', windowsReset: null, error: null, skipped: true, reason };
      }
      let outcome: ConsumeOutcome;
      try {
        const answer = await this.provider.consumeResetCredit!(account.credential, {
          redeemRequestId: randomUUID(),
          creditId: options.creditId,
          timeoutMs: this.resetCredits.timeoutMs,
          organizationUuid: account.profile?.organizationUuid ?? account.credential.organizationUuid,
        });
        outcome = classifyConsume(answer.status, answer.body);
      } catch (error) {
        const timedOut = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
        outcome = { kind: 'indeterminate', code: timedOut ? 'timeout' : 'network', windowsReset: null, error: (error as Error).message.slice(0, 200) };
      }
      this.applyRedeem(account, outcome);
      await this.saveSafely();
      this.logRedeem(account, reason, outcome);
      // Read the authoritative usage back shortly after: it confirms a reset
      // and settles what an indeterminate answer actually did.
      if (options.recheck !== false) setTimeout(() => void this.recheckUsage(account), RECHECK_DELAY_MS).unref();
      return { ...outcome, skipped: false, reason };
    })();
    const shared = run.finally(() => { account.resetCreditPromise = null; });
    account.resetCreditPromise = shared;
    return shared;
  }

  private applyRedeem(account: RuntimeAccount, outcome: ConsumeOutcome): void {
    const now = Date.now();
    account.resetCreditLastOutcome = outcome.kind === 'reset' ? 'reset' : outcome.kind === 'spent-no-reset' ? 'reset_no_windows' : outcome.code;
    if (outcome.code === 'no_credit') account.resetCredits = 0;
    if (outcome.kind === 'reset' || outcome.kind === 'spent-no-reset') {
      if (typeof account.resetCredits === 'number') account.resetCredits = Math.max(0, account.resetCredits - 1);
      account.resetCreditsConsumed = (account.resetCreditsConsumed ?? 0) + 1;
    }
    // A reset that reset nothing leaves usage and benches as they were.
    if (outcome.kind !== 'reset') return;
    account.usage = 0; account.resetsAt = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownAt = null; account.resetCreditResetAt = now;
    for (const name of ['primary', 'secondary', '5h', '7d', '7d_oi']) { const window = account.windows[name]; if (window) account.windows[name] = { ...window, usage: 0, resetsAt: null }; }
  }

  private logRedeem(account: RuntimeAccount, reason: string, outcome: ConsumeOutcome): void {
    const label = this.provider.label; const left = account.resetCredits ?? '?'; const detail = `${outcome.code}${outcome.error ? ` — ${outcome.error}` : ''}`;
    if (outcome.kind === 'reset') this.log(`${label} reset credit redeemed on "${account.label}" (${reason}): windows_reset=${outcome.windowsReset ?? '?'}, credits left=${left}`);
    else if (outcome.kind === 'spent-no-reset') this.log(`${label} reset credit SPENT on "${account.label}" (${reason}) but no window was reset (windows_reset=0); credits left=${left}`);
    else if (outcome.kind === 'indeterminate') this.log(`${label} reset credit on "${account.label}" (${reason}) indeterminate: ${detail}; re-reading usage, no other account tried this pass`);
    else this.log(`${label} reset credit NOT applied on "${account.label}" (${reason}): ${detail}`);
  }

  // One authoritative usage read for a single account, outside the timer.
  async recheckUsage(account: RuntimeAccount): Promise<void> {
    if (!this.provider.fetchUsage) return;
    try { await this.refresh(account); const quota = await this.provider.fetchUsage(account.credential); if (quota) this.applyQuota(account, quota, 'usage'); await this.saveSafely(); } catch { /* the timer reads it later */ }
  }

  // The quota dead end: no account can take the request. Spend at most one
  // ticket, trying eligible accounts in order and stopping at the first
  // answer that is not a clean "nothing spent" — trying the next account after
  // an unclear answer is exactly how two tickets get spent.
  async redeemForFleet(excluded: Set<string>, wantsFable = false, among: (account: RuntimeAccount) => boolean = () => true): Promise<{ attempted: boolean; reset: RuntimeAccount | null; yielded: boolean }> {
    const now = Date.now();
    const pool = this.accounts.filter(among);
    const reasons = pool.map((account) => ({ account, why: eligibility(account, this.resetCredits, this.provider.id, now) }));
    const candidates = candidateOrder(reasons.filter((r) => r.why === 'ok' || r.why === 'in-flight').map((r) => r.account));
    if (!candidates.length) {
      if (now - this.deadEndLoggedAt >= 60_000) { this.deadEndLoggedAt = now; this.log(`${this.provider.label} reset credit: no eligible account at the quota dead end (${reasons.map((r) => `${r.account.label}:${r.why}`).join(', ')})`); }
      return { attempted: false, reset: null, yielded: false };
    }
    let attempted = false;
    for (const account of candidates) {
      const result = await this.redeemResetCredit(account, 'fleet-exhausted', { enforce: true });
      if (result.skipped) continue;
      attempted = true;
      if (result.kind === 'reset') return { attempted, reset: account, yielded: false };
      if (result.kind !== 'no-spend') return { attempted, reset: null, yielded: false };
      // Someone else (another request, the operator, a window rolling over)
      // may have opened an account meanwhile; take that instead of a ticket.
      if (this.accounts.some((a) => among(a) && this.available(a, excluded, wantsFable, true))) return { attempted, reset: null, yielded: true };
    }
    return { attempted, reset: null, yielded: false };
  }

  // The spendable tickets on one account, for the manual picker. Served from
  // cache while fresh; a failed fetch keeps the last good list and is logged
  // once per run of failures, and retries are spaced so failures cannot spin.
  async listResetCredits(account: RuntimeAccount, force = false): Promise<ResetCredit[]> {
    if (!this.provider.fetchResetCredits) throw new Error(`${this.provider.label} has no reset credits`);
    const now = Date.now(); const cached = account.resetCreditList; const every = this.resetCredits.listRefreshMs;
    if (!force && cached && (every === 0 || now - cached.at < every)) return cached.credits;
    if (!force && cached && account.resetCreditListTriedAt && now - account.resetCreditListTriedAt < 30_000) return cached.credits;
    account.resetCreditListTriedAt = now;
    try {
      await this.refresh(account);
      const credits = await this.provider.fetchResetCredits(account.credential);
      account.resetCreditList = { credits, at: now }; account.resetCreditListFailing = false;
      return credits;
    } catch (error) {
      if (!account.resetCreditListFailing) { account.resetCreditListFailing = true; this.log(`${this.provider.label} reset credit list for "${account.label}" failed: ${(error as Error).message.slice(0, 120)}`); }
      if (cached) return cached.credits;
      throw error;
    }
  }

  exportState(target: PersistedState): void {
    const now = this.now();
    for (const a of this.accounts.filter((x) => !x.retired)) {
      const activeCooldown = a.cooldownUntil !== null && a.cooldownUntil > now;
      target.accounts[a.credentialId] = { usage: a.usage, resetsAt: a.resetsAt, windows: a.windows, profile: a.profile, measuredAt: a.measuredAt, warmupStartWindows: a.warmupStartWindows, cooldownUntil: activeCooldown ? a.cooldownUntil : null, cooldownReason: activeCooldown ? a.cooldownReason : null, cooldownAt: activeCooldown ? (a.cooldownAt ?? null) : null, lastUsed: a.lastUsed, error: a.error, ...AccountPool.ledger(a) };
    }
    if (this.probeTemplate) { target.probes ??= {}; target.probes[this.provider.id] = this.probeTemplate; }
    // What the dashboard needs to mark route accounts, worked out here since
    // the dashboard cannot judge availability itself. Judged without side
    // effects and without any request's exclusions.
    target.next ??= {}; target.next[this.provider.id] = this.nextTargets();
    if (this.routes.length) {
      target.routes ??= [];
      for (const route of this.routes) {
        target.routes.push({ provider: this.provider.id, name: route.name, color: route.color, mode: route.mode, members: this.accounts.filter((a) => this.isMember(route, a)).map((a) => ({ credentialId: a.credentialId, usable: this.eligible(a, NO_EXCLUSIONS, false, true) && !this.atConcurrencyCap(a) })) });
      }
    }
  }
}
