import type { OAuthCredential, PersistedState, Provider, RuntimeAccount, StoredAccount } from './types.js';

export class AccountPool {
  readonly accounts: RuntimeAccount[];
  private affinity = new Map<string, string>();
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
  updateQuota(account: RuntimeAccount, headers: Headers, body?: string): void { const quota = this.provider.readQuota(headers, body); if (quota) { account.usage = quota.routingUsage; account.resetsAt = quota.routingResetsAt; account.windows = { ...account.windows, ...quota.windows }; } }
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

  async refreshProfiles(): Promise<number> {
    if (!this.provider.fetchProfile) return 0;
    let updated = 0;
    for (const account of this.accounts) {
      try { await this.refresh(account); account.profile = await this.provider.fetchProfile(account.credential); updated++; } catch { /* retain last known profile */ }
    }
    return updated;
  }

  exportState(target: PersistedState): void {
    for (const a of this.accounts) target.accounts[a.credentialId] = { usage: a.usage, resetsAt: a.resetsAt, windows: a.windows, profile: a.profile, cooldownUntil: a.cooldownUntil, lastUsed: a.lastUsed, error: a.error };
  }
}
