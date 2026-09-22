import type { OAuthCredential, PersistedState, ProbeTemplate, Provider, RuntimeAccount, Shortfall, StoredAccount } from './types.js';

// An empty exclusion set, for judging an account on its own merits rather than
// on what one request has already tried.
const NO_EXCLUSIONS = new Set<string>();

export class AccountPool {
  readonly accounts: RuntimeAccount[];
  private affinity = new Map<string, string>();
  private probeTemplate: ProbeTemplate | null = null;
  private probing = false;
  private warmupTries = new Map<string, number>();
  readonly maxWarmupTries = 3;
  private refreshes = new Map<string, Promise<void>>();
  private sweepInFlight = false;

  // Accounts still holding Fable budget are kept for Fable. An account measured
  // below this line reserves its remainder; at or above it, it is the preferred
  // home for everything else. 1 disables the split.
  private reservesFable(account: RuntimeAccount): boolean {
    return this.fableReserve < 1 && !AccountPool.fableSpent(account, this.fableReserve) && AccountPool.fableWindow(account)?.usage != null;
  }

  constructor(readonly provider: Provider, stored: StoredAccount[], credentials: Record<string, OAuthCredential>, state: PersistedState, readonly threshold = 0.98, readonly maxConcurrent = 16, readonly fableReserve = 0.8, readonly maxSessions = 4096) {
    this.accounts = stored.filter((a) => a.provider === provider.id && credentials[a.credentialId]).map((account) => {
      const saved = state.accounts[account.credentialId];
      // Restore the long-lived quota state (usage/windows/reset/profile) so the
      // dashboard and ranking survive a restart without re-measuring — but NOT
      // cooldownUntil or error. Both are per-response signals: a cooldown says
      // "one 429 told us to rest this account for a while", an error says "the
      // last attempt failed". Persisting them means a restart re-benches an
      // account that may be fine now — exactly how a Fable-only 429's weekly
      // retry-after came back to park seven accounts across restarts. If the
      // account really is spent, the next request re-derives the right cooldown
      // (model-quota → Fable only, real quota → whole account).
      return { ...account, credential: credentials[account.credentialId]!, usage: saved?.usage ?? null, resetsAt: saved?.resetsAt ?? null, windows: saved?.windows ?? {}, profile: saved?.profile ?? null, cooldownUntil: null, cooldownReason: null, lastUsed: saved?.lastUsed ?? null, error: null, inflight: 0 };
    });
    // Restore the probe shape learned last run so warm-up and R work on a fresh
    // idle proxy, instead of falling back to a hardcoded client version.
    this.probeTemplate = state.probes?.[provider.id] ?? null;
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
  static generalWindow(account: { windows: Record<string, { usage: number | null; resetsAt?: number | null }> }): { usage: number | null; resetsAt?: number | null } | undefined {
    return account.windows.primary ?? account.windows.requests ?? account.windows['7d'];
  }

  // Least-spent first, so both selection and the dashboard agree on what "next"
  // means. Unmeasured accounts sort last rather than first: a null is unknown,
  // not empty, and routing to one on a hunch spends an unknown budget.
  static byHeadroom(a: RuntimeAccount, b: RuntimeAccount): number {
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

  // Ranking for traffic that does not need the top model. Accounts whose Fable
  // budget is already spent come first, so an Opus or Sonnet request lands on a
  // week that has nothing left to protect instead of eating the one account that
  // can still serve Fable. Within a tier it is least-spent on the general window,
  // which is the budget such a request actually consumes.
  //
  // Without this split, byHeadroom ranks every request on the Fable window, and
  // the account with the most Fable left is exactly the one Opus and Sonnet get
  // routed to first — the opposite of what the pool should do.
  static byNonFableHeadroom(reserve: number): (a: RuntimeAccount, b: RuntimeAccount) => number {
    return (a, b) => {
      // A reserve of 1 holds nothing back, so there is no tier to sort by — rank
      // purely on the budget the request spends.
      const ta = reserve < 1 && AccountPool.fableSpent(a, reserve);
      const tb = reserve < 1 && AccountPool.fableSpent(b, reserve);
      if (ta !== tb) return ta ? -1 : 1;
      const ua = AccountPool.generalUsage(a); const ub = AccountPool.generalUsage(b);
      if (ua === null || ub === null) return (ua === null ? 1 : 0) - (ub === null ? 1 : 0);
      if (ua !== ub) return ua - ub;
      return AccountPool.byHeadroom(a, b);
    };
  }

  // Spent for Fable purposes: at or past the reserve line, so nothing is held
  // back by sending other models here. An unmeasured Fable window is not treated
  // as spent — a null is unknown, and assuming empty would spend a budget we
  // have not looked at.
  static fableSpent(account: RuntimeAccount, reserve: number): boolean {
    const usage = AccountPool.fableWindow(account)?.usage;
    return usage !== null && usage !== undefined && usage >= reserve;
  }

  static generalUsage(account: RuntimeAccount): number | null {
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
  // (100%): it can only answer with a 429 there, so trying it just burns a real
  // upstream call and a failover hop before moving on. A non-Fable request still
  // considers it — that budget is exactly what the account has left. Note this
  // is fully spent, not `fableReserve`: at 80% there is still Fable to spend.
  //
  // The switch threshold (98%) is the point at which the pool prefers another
  // account, not a promise to leave the remainder unused. When nothing else can
  // take the request, `lastResort` admits an account that is over the
  // threshold but not measured as fully spent (<100%): upstream still answers
  // there, and if it does not, its 429 carries the real retry-after that
  // benches the account — better than refusing on a number we chose ourselves.
  private availableIgnoringConcurrency(account: RuntimeAccount, excluded: Set<string>, wantsFable = true, lastResort = false): boolean {
    const now = Date.now();
    if (account.resetsAt && account.resetsAt <= now) { account.usage = null; account.resetsAt = null; account.cooldownUntil = null; account.cooldownReason = null; }
    const limit = lastResort ? 1 : this.threshold;
    if (!(account.enabled && !account.error && !excluded.has(account.id) && (!account.cooldownUntil || account.cooldownUntil <= now) && (account.usage === null || account.usage < limit))) return false;
    if (wantsFable && AccountPool.fableSpent(account, 1)) return false;
    return true;
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
  explainShortfall(excluded: Set<string>, wantsFable: boolean): Shortfall {
    const label = this.provider.label;
    if (this.saturatedButHealthy(excluded)) {
      return { reason: 'concurrency_saturated', retryAfterMs: 5_000, message: `Every ${label} account with budget left is at its concurrency cap (${this.maxConcurrent} requests in flight each). Retry in a few seconds.` };
    }
    const now = Date.now();
    const live = this.accounts.filter((a) => a.enabled && !a.error && !excluded.has(a.id));
    const resets: Array<{ at: number; label: string }> = [];
    let fableSpent = 0; let overLimit = 0; let coolingDown = 0;
    for (const account of live) {
      const fable = AccountPool.fableWindow(account);
      if (wantsFable && AccountPool.fableSpent(account, 1)) { fableSpent++; if (fable?.resetsAt) resets.push({ at: fable.resetsAt, label: `${account.label} Fable weekly` }); continue; }
      if (account.usage !== null && account.usage >= 1) { overLimit++; if (account.resetsAt) resets.push({ at: account.resetsAt, label: `${account.label} session` }); continue; }
      if (account.cooldownUntil && account.cooldownUntil > now) { coolingDown++; resets.push({ at: account.cooldownUntil, label: `${account.label} cooldown` }); }
    }
    const next = resets.filter((r) => r.at > now).sort((a, b) => a.at - b.at)[0];
    const parts: string[] = [];
    if (fableSpent) parts.push(`${fableSpent} spent the Fable weekly budget`);
    if (overLimit) parts.push(`${overLimit} used up the session window`);
    if (coolingDown) parts.push(`${coolingDown} cooling down after an upstream rejection`);
    const what = wantsFable ? `No ${label} account can serve Fable right now` : `No ${label} account has budget left`;
    const detail = parts.length ? ` (${live.length} accounts: ${parts.join(', ')})` : ` (${live.length} accounts)`;
    const when = next ? ` Earliest reset in ${AccountPool.formatDuration(next.at - now)}: ${next.label}.` : '';
    const hint = wantsFable && fableSpent ? ' Other models are still served: switch model or wait.' : '';
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
  acquire(session: string, excluded = new Set<string>(), wantsFable = true): RuntimeAccount | null {
    const key = AccountPool.affinityKey(session, wantsFable);
    const pinned = this.accounts.find((a) => a.id === this.affinity.get(key));
    // Session affinity is a cache-locality preference, not a claim on the
    // account. Honour it while the account can take the request and while the
    // request should be spending here: an Opus turn leaves an account still
    // holding Fable budget only when a spare exists to take it — early in the
    // week every account reserves, and refusing the pin then just scatters
    // the session over the fleet for nothing.
    if (pinned && this.available(pinned, excluded, wantsFable) && !this.divertsOff(pinned, wantsFable, excluded)) { pinned.inflight++; this.remember(key, pinned.id); return pinned; }
    const rank = this.spread(wantsFable);
    // An explicit priority orders accounts within the same reservation tier,
    // never across it: a #1 account still holding Fable budget used to take
    // every Opus and Haiku turn ahead of a spare whose Fable was already
    // spent, burning the one budget only Fable turns can use.
    const diverts = (a: RuntimeAccount) => this.divertsOff(a, wantsFable, excluded) ? 1 : 0;
    const ranked = (lastResort: boolean) => this.accounts.filter((a) => this.available(a, excluded, wantsFable, lastResort)).sort((a, b) => {
      const tier = diverts(a) - diverts(b); if (tier) return tier;
      if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
      return rank(a, b);
    });
    // Prefer accounts under the switch threshold; only when none is left does
    // an account over it (but not spent) get the request rather than a 429.
    const selected = ranked(false)[0] || ranked(true)[0] || null;
    // A pinned account that is only excluded for this request (a transient
    // failover) or at its concurrency cap is still the session's home: this
    // request spills elsewhere, the pin stays, and the next turn comes back to
    // its warm cache. Only a home that is genuinely gone is replaced.
    if (selected) { selected.inflight++; if (!pinned || !this.isHome(pinned, wantsFable)) this.remember(key, selected.id); }
    return selected;
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

  // Whether a non-Fable request should leave this account for one that does
  // not reserve Fable — only when such an account can actually take it.
  private divertsOff(account: RuntimeAccount, wantsFable: boolean, excluded: Set<string>): boolean {
    return !wantsFable && this.reservesFable(account) && this.accounts.some((a) => a !== account && !this.reservesFable(a) && this.available(a, excluded, false));
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
      const now = Date.now();
      const still = account.enabled && !account.error && (account.usage === null || account.usage < this.threshold) && !(wantsFable && AccountPool.fableSpent(account, 1));
      return still && !this.divertsOff(account, wantsFable, NO_EXCLUSIONS);
    }
    return this.availableIgnoringConcurrency(account, NO_EXCLUSIONS, wantsFable) && !this.divertsOff(account, wantsFable, NO_EXCLUSIONS);
  }

  get pinnedSessions(): number { return this.affinity.size; }

  // Selection order for a new session. The static rankings compare exact
  // usage, which herds every new session onto whichever account is a point
  // lower this hour (51% vs 52%) until its weekly figure creeps past the next
  // one — a number that moves a tenth of a percent per request. Meanwhile the
  // window that actually gates the account next is often the 5-hour session
  // window, which the weekly figure never sees, so one account fills its
  // session window alone while seven sit at 0%.
  //
  // So: keep the tier (non-Fable traffic still prefers a week with no Fable
  // left to protect), compare load on the fuller of the weekly and session
  // windows in 10% steps, and inside a step prefer the account with fewer
  // requests in flight. Only then fall back to the exact ranking, so both the
  // dashboard's order and the fleet-wide preference still hold.
  private spread(wantsFable: boolean): (a: RuntimeAccount, b: RuntimeAccount) => number {
    const exact = wantsFable ? AccountPool.byHeadroom : AccountPool.byNonFableHeadroom(this.fableReserve);
    const tier = (a: RuntimeAccount) => (!wantsFable && this.fableReserve < 1 && AccountPool.fableSpent(a, this.fableReserve) ? 0 : 1);
    const bucket = (a: RuntimeAccount) => { const load = AccountPool.loadUsage(a, wantsFable); return load === null ? Number.MAX_SAFE_INTEGER : Math.floor(load * 10); };
    return (a, b) => tier(a) - tier(b) || bucket(a) - bucket(b) || a.inflight - b.inflight || exact(a, b);
  }

  // How full the account is on whichever window will gate its next request:
  // the budget this kind of request spends, or the 5-hour session window,
  // whichever is fuller. Null when neither has been measured.
  static loadUsage(account: RuntimeAccount, wantsFable: boolean): number | null {
    const budget = wantsFable ? AccountPool.headroomUsage(account) : AccountPool.generalUsage(account);
    const session = account.windows['5h']?.usage ?? null;
    if (budget === null && session === null) return null;
    return Math.max(budget ?? 0, session ?? 0);
  }

  release(account: RuntimeAccount): void { account.inflight = Math.max(0, account.inflight - 1); account.lastUsed = Date.now(); }
  updateQuota(account: RuntimeAccount, headers: Headers, body?: string): void {
    const quota = this.provider.readQuota(headers, body);
    if (quota) { account.usage = quota.routingUsage; account.resetsAt = quota.routingResetsAt; account.windows = { ...account.windows, ...quota.windows }; }
    // A live plan header is fresher than the one decoded from the token at
    // login, so a plan change shows up without re-authenticating.
    const plan = headers.get('x-codex-plan-type');
    if (plan && account.profile && account.profile.rateLimitTier !== plan) account.profile = { ...account.profile, rateLimitTier: plan };
  }
  cooldown(account: RuntimeAccount, ms: number, reason: 'network' | 'quota' | 'forbidden' = 'quota'): void { account.cooldownUntil = Date.now() + Math.max(1_000, ms); account.cooldownReason = reason; }

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
    if (!force && account.credential.expiresAt && account.credential.expiresAt > Date.now() + 5 * 60_000) return;
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
      const due = this.accounts.filter((a) => a.credential.refreshToken
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
    const now = Date.now();
    let swept = 0;
    for (const account of this.accounts) {
      let changed = false;
      for (const [name, window] of Object.entries(account.windows)) {
        if (window.resetsAt && window.resetsAt <= now) { delete account.windows[name]; changed = true; }
      }
      if (account.resetsAt && account.resetsAt <= now) { account.usage = null; account.resetsAt = null; account.cooldownUntil = null; account.cooldownReason = null; changed = true; }
      if (changed) { this.warmupTries.delete(account.credentialId); swept++; }
    }
    return swept;
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
  async warmup(): Promise<number> {
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
  // accounts to disk, the server holds the pools) so a re-measure picks up a
  // newly added account instead of requiring a restart. Live runtime state —
  // usage, cooldowns, inflight, affinity — is preserved for accounts that stay;
  // only genuinely new ones are built fresh, and removed ones drop out. An
  // account with a request in flight is never dropped mid-response.
  sync(stored: StoredAccount[], credentials: Record<string, OAuthCredential>): { added: number; removed: number } {
    const wanted = stored.filter((a) => a.provider === this.provider.id && credentials[a.credentialId]);
    const byId = new Map(this.accounts.map((a) => [a.credentialId, a]));
    const keep = new Set(wanted.map((a) => a.credentialId));
    let added = 0;
    const next: RuntimeAccount[] = [];
    for (const account of wanted) {
      const live = byId.get(account.credentialId);
      if (live) {
        // Config fields may have been edited (label, enabled, priority); runtime
        // fields and the possibly-refreshed credential stay as they are.
        next.push(Object.assign(live, { label: account.label, enabled: account.enabled, priority: account.priority }));
      } else {
        added++;
        next.push({ ...account, credential: credentials[account.credentialId]!, usage: null, resetsAt: null, windows: {}, profile: null, cooldownUntil: null, cooldownReason: null, lastUsed: null, error: null, inflight: 0 });
      }
    }
    const dropped = this.accounts.filter((a) => !keep.has(a.credentialId));
    for (const account of dropped.filter((a) => a.inflight > 0)) next.push(account);
    const removed = dropped.length - dropped.filter((a) => a.inflight > 0).length;
    this.accounts.length = 0; this.accounts.push(...next);
    for (const [session, id] of this.affinity) if (!this.accounts.some((a) => a.id === id)) this.affinity.delete(session);
    return { added, removed };
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

  // Force a fleet-wide quota re-measure (TUI 'R'). Replays the committed
  // template against every idle account, including already-measured and
  // throttled ones: an exhausted account's 429 still carries authoritative
  // quota headers. Tokens are refreshed first — an idle account past its token
  // lifetime is the main reason a refresh would otherwise measure nothing.
  // Returns { targets, measured } so the TUI can report honest M/N.
  async probeAll(): Promise<{ targets: number; measured: number }> {
    // Fall back to the shape this provider knows its client sends. A pool whose
    // accounts are ALL exhausted never serves a request, so it can never capture
    // a template from live traffic — and would stay permanently unmeasurable,
    // which is exactly when the numbers matter most.
    if (!this.probeTemplate && this.provider.defaultProbe) this.probeTemplate = this.provider.defaultProbe();
    if (!this.hasProbe() || this.probing) return { targets: 0, measured: 0 };
    this.probing = true;
    try {
      this.warmupTries.clear();
      const targets = this.accounts.filter((a) => a.inflight === 0);
      await Promise.all(targets.map((a) => this.refresh(a).catch(() => { /* surfaced below */ })));
      // Re-check inflight after the await: a live request may have been routed
      // to an account while tokens were refreshing, and a probe does not go
      // through acquire/release, so probing it would exceed maxConcurrent.
      const alive = targets.filter((a) => !a.error && a.inflight === 0);
      const results = await Promise.all(alive.map((a) => this.probeOne(a)));
      // Model-weekly (Fable) top-up: that window only appears on responses to
      // Fable-tier requests, so an account measured by an ordinary probe keeps
      // a blank Fbl bar forever. Re-probe those once with the Fable model.
      const fableModel = this.provider.fableModel;
      if (fableModel) {
        const missing = alive.filter((a) => !Object.keys(a.windows).some((name) => /^7d_[a-z0-9]+$/i.test(name)));
        if (missing.length) await Promise.all(missing.map((a) => this.probeOne(a, fableModel)));
      }
      return { targets: targets.length, measured: results.filter(Boolean).length };
    } finally { this.probing = false; }
  }

  private async probeOne(account: RuntimeAccount, modelOverride?: string): Promise<boolean> {
    const template = this.probeTemplate;
    if (!template || !this.provider.probeRequest) return false;
    try {
      const shape = this.provider.probeRequest(modelOverride ? { ...template, model: modelOverride } : template, account.credential);
      const response = await fetch(shape.url, { method: 'POST', headers: shape.headers, body: shape.body, signal: AbortSignal.timeout(30_000) });
      const text = response.status >= 400 ? await response.text() : '';
      await response.body?.cancel().catch(() => { /* already consumed */ });
      // "Measured" means this probe actually carried quota headers — not merely
      // that the account already had a number from before. Ask the provider what
      // it read, so a header-less response (a 400/404, an upstream hiccup) is
      // reported as unmeasured instead of inflating the M/N the TUI shows.
      const quota = this.provider.readQuota(response.headers, text);
      if (quota) { account.usage = quota.routingUsage; account.resetsAt = quota.routingResetsAt; account.windows = { ...account.windows, ...quota.windows }; }
      if (response.ok) { account.error = null; account.cooldownUntil = null; account.cooldownReason = null; account.cooldownReason = null; }
      // A rejection that only names the model-weekly window says the account is
      // spent for the top model, not unusable: an ordinary probe (the default
      // model) still succeeds here. Clearing the bench on that reading is what
      // lets R recover an account parked for days by a Fable-only 429 — the
      // cooldown it was given was the weekly retry-after, which no other model
      // has to wait for.
      else if (!modelOverride && this.provider.classifyFailure(response.status, response.headers, text).kind === 'model-quota') {
        account.error = null; account.cooldownUntil = null; account.cooldownReason = null;
      }
      return quota !== null;
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

  exportState(target: PersistedState): void {
    for (const a of this.accounts) target.accounts[a.credentialId] = { usage: a.usage, resetsAt: a.resetsAt, windows: a.windows, profile: a.profile, cooldownUntil: a.cooldownUntil, lastUsed: a.lastUsed, error: a.error };
    if (this.probeTemplate) { target.probes ??= {}; target.probes[this.provider.id] = this.probeTemplate; }
  }
}
