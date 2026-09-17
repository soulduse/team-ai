import type { OAuthCredential, PersistedState, ProbeTemplate, Provider, RuntimeAccount, StoredAccount } from './types.js';

export class AccountPool {
  readonly accounts: RuntimeAccount[];
  private affinity = new Map<string, string>();
  private probeTemplate: ProbeTemplate | null = null;
  private probing = false;
  private refreshes = new Map<string, Promise<void>>();

  constructor(readonly provider: Provider, stored: StoredAccount[], credentials: Record<string, OAuthCredential>, state: PersistedState, readonly threshold = 0.98, readonly maxConcurrent = 3) {
    this.accounts = stored.filter((a) => a.provider === provider.id && credentials[a.credentialId]).map((account) => {
      const saved = state.accounts[account.credentialId];
      return { ...account, credential: credentials[account.credentialId]!, usage: saved?.usage ?? null, resetsAt: saved?.resetsAt ?? null, windows: saved?.windows ?? {}, profile: saved?.profile ?? null, cooldownUntil: saved?.cooldownUntil ?? null, lastUsed: saved?.lastUsed ?? null, error: saved?.error ?? null, inflight: 0 };
    });
  }

  private available(account: RuntimeAccount, excluded: Set<string>): boolean {
    const now = Date.now();
    if (account.resetsAt && account.resetsAt <= now) { account.usage = null; account.resetsAt = null; account.cooldownUntil = null; }
    return account.enabled && !account.error && !excluded.has(account.id) && (!account.cooldownUntil || account.cooldownUntil <= now) && (account.usage === null || account.usage < this.threshold) && account.inflight < this.maxConcurrent;
  }

  acquire(session: string, excluded = new Set<string>()): RuntimeAccount | null {
    const pinned = this.accounts.find((a) => a.id === this.affinity.get(session));
    if (pinned && this.available(pinned, excluded)) { pinned.inflight++; return pinned; }
    const candidates = this.accounts.filter((a) => this.available(a, excluded)).sort((a, b) => {
      if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
      if (a.resetsAt !== b.resetsAt) return (a.resetsAt ?? Number.MAX_SAFE_INTEGER) - (b.resetsAt ?? Number.MAX_SAFE_INTEGER);
      return (a.usage ?? 0) - (b.usage ?? 0);
    });
    const selected = candidates[0] || null;
    if (selected) { selected.inflight++; this.affinity.set(session, selected.id); }
    return selected;
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
  cooldown(account: RuntimeAccount, ms: number): void { account.cooldownUntil = Date.now() + Math.max(1_000, ms); }
  fail(account: RuntimeAccount, message: string): void { account.error = message; }

  async refresh(account: RuntimeAccount, force = false): Promise<void> {
    if (!force && account.credential.expiresAt && account.credential.expiresAt > Date.now() + 5 * 60_000) return;
    const existing = this.refreshes.get(account.id);
    if (existing) return existing;
    const promise = this.provider.refresh(account.credential).then((next) => { account.credential = next; account.error = null; }).finally(() => this.refreshes.delete(account.id));
    this.refreshes.set(account.id, promise);
    return promise;
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
        next.push({ ...account, credential: credentials[account.credentialId]!, usage: null, resetsAt: null, windows: {}, profile: null, cooldownUntil: null, lastUsed: null, error: null, inflight: 0 });
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
      if (response.ok) { account.error = null; account.cooldownUntil = null; }
      return quota !== null;
    } catch { return false; }
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
  }
}
