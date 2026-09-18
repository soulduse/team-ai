// The dashboard as pure text: given a config and a state, produce the lines the
// screen would show. The interactive loop in tui.ts and the file capture in
// capture.ts both draw through here, so a capture is exactly what a person at
// the terminal would have seen — same ordering, same gauges, same colors.
import type { PersistedState, StoredAccount, SubscriptionProfile, TeamAIConfig } from './types.js';

export const ESC = '\x1b['; const RESET = `${ESC}0m`; const ANSI = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
const visible = (text: string): number => text.replace(ANSI, '').length;
const fit = (text: string, width: number): string => { const plain = text.replace(ANSI, ''); if (plain.length > width) return `${plain.slice(0, Math.max(0, width - 1))}…`; return text + ' '.repeat(Math.max(0, width - visible(text))); };

function duration(reset: number | null | undefined): string {
  if (!reset || reset <= Date.now()) return '';
  const mins = Math.ceil((reset - Date.now()) / 60_000); if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60); if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

function bar(usage: number | null | undefined, reset: number | null | undefined, width: number): string {
  const remaining = duration(reset); const ratio = usage == null ? null : Math.max(0, Math.min(1, usage));
  const label = ratio == null ? (remaining || '-') : `${Math.round(ratio * 100)}%${remaining && `${Math.round(ratio * 100)}% ${remaining}`.length <= width ? ` ${remaining}` : ''}`;
  const text = label.slice(0, width).padStart(Math.floor((width + label.length) / 2)).padEnd(width);
  if (ratio == null) return `${ESC}100;37m${text}${RESET}`;
  const filled = Math.round(ratio * width); const bg = ratio >= 0.9 ? 41 : ratio >= 0.7 ? 43 : 42;
  return `${ESC}${bg};97m${text.slice(0, filled)}${ESC}100;37m${text.slice(filled)}${RESET}`;
}

function healthy(profile: SubscriptionProfile | null | undefined): boolean { return !profile?.status || ['active', 'trialing'].includes(profile.status); }
// ChatGPT plan ids are lowercase slugs ('pro', 'prolite', 'plus', 'team'); show
// them the way the product names them so a Codex row reads like a Claude one.
function codexPlan(profile: SubscriptionProfile | null | undefined): string {
  const raw = profile?.rateLimitTier;
  // Before the first profile refresh there is nothing to show yet; say so
  // rather than printing a brand name that looks like a plan.
  if (!raw) return '—';
  const names: Record<string, string> = { pro: 'Pro', prolite: 'Pro Lite', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', free: 'Free' };
  // ChatGPT exposes no Max-style multiplier anywhere: not in the token claims,
  // not in a header that arrives on every response, and not derivable from the
  // quota windows either — Pro and Pro Lite both report a 10080-minute window
  // and a percentage, never the absolute allowance the percentage is of. The
  // plan name is the whole of what can be known.
  return names[raw.toLowerCase()] || raw;
}
function tier(profile: SubscriptionProfile | null | undefined): string {
  if (!profile) return 'OAuth'; const match = /(\d+x)$/i.exec(profile.rateLimitTier || '');
  if (match) return `Max ${match[1]}`; if (profile.hasClaudeMax || profile.orgType === 'claude_max') return 'Max'; if (profile.hasClaudePro || profile.orgType === 'claude_pro') return 'Pro'; return 'OAuth';
}
function renewal(profile: SubscriptionProfile | null | undefined): string {
  if (!profile?.createdAt || !healthy(profile)) return '—'; const created = new Date(profile.createdAt); if (!Number.isFinite(created.getTime())) return '—';
  const now = new Date(); const day = created.getDate(); const build = (year: number, month: number): Date => new Date(year, month, Math.min(day, new Date(year, month + 1, 0).getDate())); let target = build(now.getFullYear(), now.getMonth()); if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) target = build(now.getFullYear(), now.getMonth() + 1);
  const left = Math.round((target.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86_400_000); return left <= 0 ? 'D-DAY' : `D-${left}`;
}

// A quota window upstream is actually enforcing. ChatGPT sends both `primary`
// and `secondary` on every response, but an account may have only one in play:
// the unused one arrives with a zero-length window, no reset and 0% — which
// would otherwise render as a full, untouched bar and read as spare capacity.
function activeWindow(window: { usage: number | null; resetsAt: number | null; minutes?: number | null } | undefined): boolean {
  if (!window) return false;
  return Boolean(window.minutes) || window.resetsAt !== null || (window.usage ?? 0) > 0;
}

// A quota window's own length, named the way a person would say it ("5h", "7d").
// Codex reports the span in its headers; Claude's window names already carry it.
function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// The accounts in the order the screen draws them: grouped by provider, and
// within a group least-spent first unless the roster was switched back to
// configured order. Everything that walks rows — rendering, ↑↓ movement, the
// initial cursor — goes through this one function, so the cursor always lands
// on the adjacent visible row rather than the adjacent entry in config.json.
export function displayOrder(accounts: StoredAccount[], state: PersistedState, byHeadroom: boolean): StoredAccount[] {
  // Mirrors AccountPool.byHeadroom: least-spent first on the binding window
  // (Claude's Fable bucket, Codex's main one), then — once they all tie at
  // spent — whichever frees up soonest, unmeasured last, pinned priority first.
  const rank = (account: StoredAccount): { usage: number | null; resetsAt: number | null } => {
    const saved = state.accounts[account.credentialId];
    const windows = saved?.windows || {};
    const binding = Object.entries(windows).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1]
      ?? windows.primary ?? windows.requests ?? windows['7d'];
    return { usage: binding?.usage ?? saved?.usage ?? null, resetsAt: binding?.resetsAt ?? saved?.resetsAt ?? null };
  };
  const ordered: StoredAccount[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (byHeadroom) {
      group.sort((a, b) => {
        if (a.priority !== null || b.priority !== null) return (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
        const ra = rank(a); const rb = rank(b);
        if (ra.usage === null || rb.usage === null) return (ra.usage === null ? 1 : 0) - (rb.usage === null ? 1 : 0);
        if (ra.usage !== rb.usage) return ra.usage - rb.usage;
        return (ra.resetsAt ?? Number.MAX_SAFE_INTEGER) - (rb.resetsAt ?? Number.MAX_SAFE_INTEGER);
      });
    }
    ordered.push(...group);
  }
  return ordered;
}

export type FrameMode = 'normal' | 'order' | 'delete' | 'add';

export interface FrameView {
  width: number;
  // The terminal's row count when drawing live: the activity pane grows to
  // fill it and the frame is padded and clipped to exactly that many rows.
  // Absent for a capture, which shows a fixed slice of activity and no padding.
  height?: number;
  selectedId: string | null;
  mode: FrameMode;
  message: string;
  sortByHeadroom: boolean;
}

export function buildFrame(config: TeamAIConfig, state: PersistedState, view: FrameView): string[] {
  const { width, height, selectedId, mode, message, sortByHeadroom } = view;
  const accounts = config.accounts; const ordered = displayOrder(accounts, state, sortByHeadroom);
  const barWidth = width >= 120 ? 18 : 12; const lines: string[] = [];
  const claudeCount = accounts.filter((account) => account.provider === 'claude').length; const codexCount = accounts.filter((account) => account.provider === 'codex').length;
  const headerLeft = color(1, ' TeamAI'); const headerRight = `${color(32, '● running')}  Claude ${claudeCount}  Codex ${codexCount}  ${config.proxy.host}:${config.proxy.claudePort}/${config.proxy.codexPort} `;
  lines.push(`${headerLeft}${' '.repeat(Math.max(1, width - visible(headerLeft) - visible(headerRight)))}${headerRight}`); lines.push('━'.repeat(width));
  for (const provider of ['claude', 'codex'] as const) {
    const group = ordered.filter((account) => account.provider === provider); if (!group.length) continue;
    const sectionTitle = ` ${provider === 'claude' ? 'Claude' : 'Codex'} accounts (${group.length}) `;
    lines.push(color(36, `┌─${sectionTitle}${'─'.repeat(Math.max(0, width - sectionTitle.length - 3))}┐`));
    // Column titles: the rows are dense and every field below is an
    // abbreviation, so name them once per section rather than expecting the
    // reader to infer what "auto" or a bare percentage refers to.
    const slot = (title: string): string => ` ${fit(title, barWidth)}`;
    // Codex titles follow whatever windows are actually in play for this
    // section, so the header never advertises a gauge that no row renders.
    const codexWindowCount = Math.max(...group.map((account) => {
      const saved = state.accounts[account.credentialId];
      return [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow).length;
    }), 0);
    // Codex window lengths vary by account, so the title carries the span the
    // rows no longer repeat; fall back to a neutral name when they disagree.
    const codexSpans = group.map((account) => {
      const saved = state.accounts[account.credentialId];
      return [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow).map((window) => windowLabel(window!.minutes, ''));
    });
    const spanAt = (index: number): string => {
      const seen = new Set(codexSpans.map((spans) => spans[index]).filter(Boolean));
      return seen.size === 1 ? `${[...seen][0]} limit` : index === 0 ? 'usage limit' : 'second limit';
    };
    const usageTitles = provider === 'claude'
      ? `${slot('5h session')}${slot('7d overall')}${slot('7d Fable')}`
      : Array.from({ length: codexWindowCount }, (_, index) => slot(spanAt(index))).join('');
    lines.push(color(90, fit(`  ${fit('account', 24)} ${fit('plan', 10)} ${fit('state', 10)} ${'order'.padEnd(4)}${usageTitles}`, width)));
    for (const account of group) {
      const saved = state.accounts[account.credentialId]; const profile = saved?.profile; const cursor = account.credentialId === selectedId ? color(36, '>') : ' '; const enabled = account.enabled ? (saved?.error ? color(31, 'error') : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? color(33, 'cooldown') : color(32, 'active')) : color(90, 'disabled'); const rank = account.priority == null ? 'auto' : `#${account.priority}`;
      const plan = provider === 'claude' && profile && !healthy(profile) ? color(31, profile.status || 'inactive') : provider === 'claude' ? tier(profile) : codexPlan(profile);
      const head = `${cursor} ${fit(account.label, 24)} ${fit(plan, 10)} ${fit(enabled, 10)} ${rank.padEnd(4)}`;
      if (provider === 'claude') {
        const session = saved?.windows?.['5h']; const weekly = saved?.windows?.['7d']; const fable = saved?.windows?.['7d_oi'] || Object.entries(saved?.windows || {}).find(([name]) => name.startsWith('7d_'))?.[1]; const renew = renewal(profile); const renewColored = renew === 'D-DAY' || /^D-[0-3]$/.test(renew) ? color(31, renew) : /^D-[4-7]$/.test(renew) ? color(33, renew) : color(32, renew);
        lines.push(`${head} ${bar(session?.usage, session?.resetsAt, barWidth)} ${bar(weekly?.usage, weekly?.resetsAt, barWidth)} ${bar(fable?.usage, fable?.resetsAt, barWidth)} ~${renewColored}`);
      } else {
        const shown = [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow);
        const gauges = shown.map((window) => bar(window!.usage, window!.resetsAt, barWidth)).join(' ');
        lines.push(`${head} ${gauges || color(90, 'no quota data yet')}`);
      }
    }
    lines.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  }
  const activityRows = height === undefined ? 8 : Math.max(4, height - lines.length - 5); lines.push(''); lines.push(` Activity ${'─'.repeat(Math.max(0, width - 10))}`);
  for (const event of [...(state.events || [])].reverse().slice(0, activityRows)) lines.push(`${color(90, new Date(event.at).toLocaleTimeString('en-GB'))} ${event.message}`);
  if (height !== undefined) while (lines.length < height - 2) lines.push('');
  lines.push('─'.repeat(width));
  const footer = mode === 'normal' ? ` 1 Claude  2 Codex  ↑↓ select  s switch  e enable  o order  d delete  a add  p capture  R Reload  c ${sortByHeadroom ? 'quota' : 'config'}-sort  q quit` : mode === 'order' ? ' ORDER: ↑↓ rank   a/c auto   Enter/Esc done' : mode === 'delete' ? ' DELETE selected account? y/Enter confirm   Esc cancel' : ' ADD: 1 Claude login   2 Codex login   Esc cancel';
  // The message is the part that matters when there is one — a capture path,
  // a failure — so when both do not fit it is the key hints that give way.
  const status = message ? `   ${message}` : '';
  lines.push(status && footer.length + status.length > width ? `${fit(footer, Math.max(0, width - status.length))}${status}` : fit(`${footer}${status}`, width));
  return (height === undefined ? lines : lines.slice(0, height)).map((line) => fit(line, width));
}
