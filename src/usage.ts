// A machine-readable read-out of the fleet's quota, for other sessions,
// scripts and agents. The dashboard and `teamai capture` are for people; this
// is the same data as JSON. The server answers it live from its pools on the
// control port (GET /usage); with no server, `teamai usage` builds the same
// report from state.json. Fields are picked one by one — never spread from an
// account — so a credential can never ride along into the output.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AccountPool } from './account-pool.js';
import { resetTickets, resetTicketsStale } from './frame.js';
import { isRedactLevel, maskLabel, redactor, type RedactLevel } from './redact.js';
import type { LiveAccountStatus, PersistedState, ProviderId, TeamAIConfig } from './types.js';

export interface UsageWindowReport { usage: number | null; resetsAt: string | null; resetsInMs: number | null; minutes?: number | null }

// Limit-reset tickets (Claude only): counts, not redeemed. `stale` when the counts
// have not been re-read in a day, so they may already be spent.
export interface UsageResetTicketsReport { general: number; fable: number; nextExpiry: string | null; readAt: string | null; stale: boolean }

export interface UsageAccountReport {
  id: string;
  label: string;
  enabled: boolean;
  priority: number | null;
  plan: string | null;
  usage: number | null;
  windows: Record<string, UsageWindowReport>;
  measuredAt: string | null;
  resetTickets: UsageResetTicketsReport | null;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  error: string | null;
  inflight: number | null;
  available: boolean;
}

export interface UsageProviderReport {
  summary: { accounts: number; enabled: number; available: number; nextResetAt: string | null };
  accounts: UsageAccountReport[];
}

export interface UsageReport {
  source: 'live' | 'state';
  generatedAt: string;
  providers: Record<ProviderId, UsageProviderReport>;
}

export interface UsageReportOptions { source: 'live' | 'state'; level?: RedactLevel; live?: LiveAccountStatus[]; now?: number }

const iso = (ms: number | null | undefined): string | null => (ms == null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

export function buildUsageReport(config: TeamAIConfig, state: PersistedState, options: UsageReportOptions): UsageReport {
  const now = options.now ?? Date.now(); const level = options.level ?? 'partial';
  const mask = redactor(config.accounts, level);
  const live = new Map((options.live ?? []).map((status) => [status.credentialId, status]));
  const providers = { claude: { summary: { accounts: 0, enabled: 0, available: 0, nextResetAt: null }, accounts: [] }, codex: { summary: { accounts: 0, enabled: 0, available: 0, nextResetAt: null }, accounts: [] } } as Record<ProviderId, UsageProviderReport>;
  const nextReset: Record<ProviderId, number | null> = { claude: null, codex: null };
  config.accounts.forEach((account, index) => {
    const saved = state.accounts[account.credentialId]; const status = live.get(account.credentialId);
    const windows: Record<string, UsageWindowReport> = {};
    for (const [name, window] of Object.entries(saved?.windows ?? {})) {
      // A window whose reset has passed no longer limits anything; the server
      // sweeps it on its next tick, so do not report it as current here.
      if (window.resetsAt != null && window.resetsAt <= now) continue;
      windows[name] = { usage: window.usage, resetsAt: iso(window.resetsAt), resetsInMs: window.resetsAt == null ? null : window.resetsAt - now, ...(window.minutes !== undefined ? { minutes: window.minutes } : {}) };
      if (account.enabled && window.resetsAt != null) nextReset[account.provider] = Math.min(nextReset[account.provider] ?? Infinity, window.resetsAt);
    }
    // Past the account's reset the server treats its usage and cooldown as
    // cleared (AccountPool.availableIgnoringConcurrency / sweepExpired), even
    // before a sweep has run. Judge the same way, or a reset account reads as
    // spent — for hours, in a report built from state.json with no server.
    const lapsed = saved?.resetsAt != null && saved.resetsAt <= now;
    const cooldownUntil = lapsed ? null : status ? status.cooldownUntil : saved?.cooldownUntil ?? null;
    const coolingDown = cooldownUntil != null && cooldownUntil > now;
    const usage = lapsed ? null : saved?.usage ?? null; const error = saved?.error ?? null;
    const available = account.enabled && !error && !coolingDown && (usage == null || usage < config.switchThreshold);
    const group = providers[account.provider];
    group.accounts.push({
      id: account.id, label: maskLabel(account.label, level, index), enabled: account.enabled, priority: account.priority,
      plan: saved?.profile?.rateLimitTier ?? null, usage, windows, measuredAt: iso(saved?.measuredAt),
      resetTickets: account.provider === 'claude' && saved?.resetCredits ? { general: saved.resetCredits.general, fable: saved.resetCredits.fable, nextExpiry: iso(saved.resetCredits.nextExpiry), readAt: iso(saved.resetCredits.readAt), stale: resetTicketsStale(saved.resetCredits, now) } : null,
      cooldownUntil: coolingDown ? iso(cooldownUntil) : null, cooldownReason: coolingDown ? status?.cooldownReason ?? null : null,
      error: error === null ? null : mask(error), inflight: status ? status.inflight : null, available,
    });
    group.summary.accounts++; if (account.enabled) group.summary.enabled++; if (available) group.summary.available++;
  });
  for (const id of ['claude', 'codex'] as const) providers[id].summary.nextResetAt = iso(nextReset[id]);
  return { source: options.source, generatedAt: new Date(now).toISOString(), providers };
}

const percent = (usage: number | null | undefined): string => (usage == null ? '—' : `${Math.round(usage * 100)}%`);

// One row per account: every window the account reports, and how long until
// the soonest of them rolls over.
export function formatUsageTable(report: UsageReport): string {
  const lines = [`TeamAI usage (${report.source === 'live' ? 'live from the server' : 'from state.json — server down or older than /usage'}, ${report.generatedAt})`];
  for (const id of ['claude', 'codex'] as const) {
    const group = report.providers[id]; if (!group.accounts.length) continue;
    lines.push('', `${id}: ${group.summary.available}/${group.summary.enabled} available${group.summary.nextResetAt ? `, next reset ${AccountPool.formatDuration(Date.parse(group.summary.nextResetAt) - Date.parse(report.generatedAt))}` : ''}`);
    for (const account of group.accounts) {
      const windows = Object.entries(account.windows).map(([name, w]) => `${name} ${percent(w.usage)}${w.resetsInMs != null ? ` (${AccountPool.formatDuration(w.resetsInMs)})` : ''}`).join('  ');
      const flags = [!account.enabled ? 'off' : '', account.cooldownUntil ? `cooldown${account.cooldownReason ? `:${account.cooldownReason}` : ''}` : '', account.error ? 'error' : '', account.inflight ? `${account.inflight} in flight` : ''].filter(Boolean).join(', ');
      const tickets = resetTickets(account.resetTickets);
      lines.push(`  ${account.available ? '●' : '○'} ${account.label}  ${windows || 'unmeasured'}${tickets ? `  resets ${tickets}${account.resetTickets?.stale ? ' (stale)' : ''}` : ''}${flags ? `  [${flags}]` : ''}`);
    }
  }
  return lines.join('\n');
}

// The request target as a URL, or null when it does not parse (`//`, say).
// new URL throws on those, and a throw inside the control server's async
// handler is an unhandled rejection that would take the whole relay down.
export function requestUrl(req: IncomingMessage): URL | null {
  try { return new URL(req.url || '/', 'http://localhost'); } catch { return null; }
}

// GET /usage on the control port. The caller has already checked the client
// token and parsed the URL; this only reads, so it is safe to answer as often
// as asked.
export function serveUsage(url: URL, res: ServerResponse, build: (level: RedactLevel) => Promise<UsageReport> | UsageReport): Promise<void> {
  const requested = url.searchParams.get('redact') ?? 'partial';
  if (!isRedactLevel(requested)) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'redact must be partial, full or none' })); return Promise.resolve(); }
  return Promise.resolve(build(requested)).then(
    (report) => { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(report)); },
    (error) => { res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (error as Error).message })); },
  );
}
