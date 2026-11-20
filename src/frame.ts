// The dashboard as pure text: given a config and a state, produce the lines the
// screen would show. The interactive loop in tui.ts and the file capture in
// capture.ts both draw through here, so a capture is exactly what a person at
// the terminal would have seen — same ordering, same gauges, same colors.
import type { DisplayItem, PersistedState, ProviderId, StoredAccount, ResetCredits, SubscriptionProfile, TeamAIConfig } from './types.js';

// Everything the `v` menu can show or hide, in menu order. The menu, the
// stored keys and the frame all read this one list.
export const DISPLAY_ITEMS: readonly { key: DisplayItem; label: string; group: string }[] = [
  { key: 'section:claude', label: 'Claude accounts', group: 'Section' },
  { key: 'section:codex', label: 'Codex accounts', group: 'Section' },
  { key: 'gauge:5h', label: 'Claude 5h session', group: 'Gauge' },
  { key: 'gauge:7d', label: 'Claude 7d overall', group: 'Gauge' },
  { key: 'gauge:fable', label: 'Claude 7d Fable', group: 'Gauge' },
  { key: 'gauge:resets', label: 'Claude reset tickets', group: 'Gauge' },
  { key: 'gauge:codex-1', label: 'Codex first limit', group: 'Gauge' },
  { key: 'gauge:codex-2', label: 'Codex second limit', group: 'Gauge' },
  { key: 'col:plan', label: 'Plan', group: 'Column' },
  { key: 'col:state', label: 'State', group: 'Column' },
  { key: 'col:order', label: 'Order', group: 'Column' },
  { key: 'col:renewal', label: 'Renewal (D-N)', group: 'Column' },
  { key: 'col:age', label: 'Measured (4m ago)', group: 'Column' },
  { key: 'activity', label: 'Activity log', group: 'Panel' },
];
const PROVIDERS: readonly ProviderId[] = ['claude', 'codex'];

export function shown(config: Pick<TeamAIConfig, 'display'>, key: DisplayItem): boolean { return !config.display?.hidden?.includes(key); }
export function toggleShown(config: TeamAIConfig, key: DisplayItem): boolean {
  const hidden = new Set(config.display?.hidden ?? []);
  if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
  config.display = { ...config.display, hidden: DISPLAY_ITEMS.map((item) => item.key).filter((k) => hidden.has(k)) };
  return !hidden.has(key);
}
// Providers whose section is on screen; the cursor only ever walks these.
export function visibleProviders(config: Pick<TeamAIConfig, 'display'>): ProviderId[] { return PROVIDERS.filter((id) => shown(config, `section:${id}`)); }

export const ESC = '\x1b['; const RESET = `${ESC}0m`; const ANSI = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');
// Green, yellow and red are drawn as explicit colors rather than the
// terminal's numbered ones: many themes render ANSI green as olive, which made
// every healthy gauge look yellowish. 24-bit where the terminal says it can
// (COLORTERM), the nearest 256-color entry otherwise. Other codes stay themed.
type Tone = { rgb: readonly [number, number, number]; xterm: number };
const TONES: Record<string, Tone> = {
  fg31: { rgb: [235, 100, 100], xterm: 203 }, fg32: { rgb: [92, 200, 130], xterm: 78 }, fg33: { rgb: [230, 180, 70], xterm: 179 },
  bgOk: { rgb: [46, 140, 84], xterm: 29 }, bgWarn: { rgb: [190, 135, 35], xterm: 136 }, bgFull: { rgb: [192, 68, 68], xterm: 167 },
  bgEmpty: { rgb: [66, 70, 78], xterm: 238 }, fgEmpty: { rgb: [200, 204, 212], xterm: 252 },
};
const truecolor = (): boolean => /truecolor|24bit/i.test(process.env.COLORTERM ?? '');
const tone = (layer: 38 | 48, name: string): string => { const t = TONES[name]!; return truecolor() ? `${layer};2;${t.rgb.join(';')}` : `${layer};5;${t.xterm}`; };
const color = (code: number, text: string): string => `${ESC}${TONES[`fg${code}`] ? tone(38, `fg${code}`) : code}m${text}${RESET}`;
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
  const empty = `${ESC}${tone(48, 'bgEmpty')};${tone(38, 'fgEmpty')}m`;
  if (ratio == null) return `${empty}${text}${RESET}`;
  const filled = Math.round(ratio * width); const bg = tone(48, ratio >= 0.9 ? 'bgFull' : ratio >= 0.7 ? 'bgWarn' : 'bgOk');
  return `${ESC}${bg};97m${text.slice(0, filled)}${empty}${text.slice(filled)}${RESET}`;
}

// How old a row's figures are. Headers refresh only the accounts the proxy
// routes to and the usage sweep runs on a timer, so without this a number
// nobody has re-read looks exactly like a live one. Dim while fresh, yellow
// once it is older than a few sweeps would allow.
function age(at: number | null | undefined): string {
  if (!at) return color(90, 'unmeasured');
  const mins = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  const text = mins < 1 ? 'now' : mins < 60 ? `${mins}m ago` : mins < 1440 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
  return color(mins > 15 ? 33 : 90, text);
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
// Anthropic renamed Max 20x to Ultra (November 2026), but the profile API still
// reports 'default_claude_max_20x', so the 20x tier is shown under its current
// name; a later 'ultra' tier or org type reads the same. A tier this function
// does not recognise is shown as reported rather than as 'OAuth', so a renamed
// plan never reads like an account with no subscription at all.
export function claudeTier(profile: SubscriptionProfile | null | undefined): string {
  if (!profile) return 'OAuth';
  const raw = profile.rateLimitTier || ''; const org = profile.orgType || '';
  if (/ultra/i.test(raw) || /ultra/i.test(org)) return 'Ultra';
  const match = /(\d+x)$/i.exec(raw);
  if (match) return match[1]!.toLowerCase() === '20x' ? 'Ultra' : `Max ${match[1]}`;
  if (profile.hasClaudeMax || org === 'claude_max') return 'Max';
  if (profile.hasClaudePro || org === 'claude_pro') return 'Pro';
  const reported = raw.replace(/^default_claude_/i, '') || org.replace(/^claude_/i, '');
  return reported || 'OAuth';
}
// Limit-reset tickets the account holds: `R<n>` whole-week, `F<n>` Fable-only; nothing when it has none.
export function resetTickets(credits: Pick<ResetCredits, 'general' | 'fable'> | null | undefined): string {
  if (!credits || (credits.general === 0 && credits.fable === 0)) return '';
  return [credits.general ? `R${credits.general}` : '', credits.fable ? `F${credits.fable}` : ''].filter(Boolean).join(' ');
}
// Counts survive a response without tickets, so one nobody has re-read in a day
// (or of unknown age) may already be spent; it is shown dimmed / marked stale.
const TICKETS_STALE_MS = 24 * 3_600_000;
export function resetTicketsStale(credits: ResetCredits | null | undefined, now = Date.now()): boolean {
  return !credits?.readAt || now - credits.readAt > TICKETS_STALE_MS;
}
// The `teamai accounts` suffix: ` resets R1 F3 (first expires 2026-12-10)`, or nothing.
export function resetTicketsNote(credits: ResetCredits | null | undefined): string {
  const tickets = resetTickets(credits); if (!tickets) return '';
  const expiry = credits?.nextExpiry ? ` (first expires ${new Date(credits.nextExpiry).toISOString().slice(0, 10)})` : '';
  return ` resets ${tickets}${expiry}${resetTicketsStale(credits) ? ', stale' : ''}`;
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
export function displayOrder(accounts: StoredAccount[], state: PersistedState, byHeadroom: boolean, providers: readonly ProviderId[] = PROVIDERS): StoredAccount[] {
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
  for (const provider of providers) {
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

export type FrameMode = 'normal' | 'order' | 'delete' | 'add' | 'view';

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
  // Row of DISPLAY_ITEMS under the cursor while the `v` menu is open.
  viewCursor?: number;
}

export function buildFrame(config: TeamAIConfig, state: PersistedState, view: FrameView): string[] {
  const { width, height, selectedId, mode, message, sortByHeadroom } = view;
  const on = (key: DisplayItem): boolean => shown(config, key);
  const providers = visibleProviders(config);
  const accounts = config.accounts; const ordered = displayOrder(accounts, state, sortByHeadroom, providers);
  const barWidth = width >= 120 ? 18 : 12; const lines: string[] = [];
  const claudeCount = accounts.filter((account) => account.provider === 'claude').length; const codexCount = accounts.filter((account) => account.provider === 'codex').length;
  const headerLeft = color(1, ' TeamAI'); const headerRight = `${color(32, '● running')}  Claude ${claudeCount}  Codex ${codexCount}  ${config.proxy.host}:${config.proxy.claudePort}/${config.proxy.codexPort} `;
  lines.push(`${headerLeft}${' '.repeat(Math.max(1, width - visible(headerLeft) - visible(headerRight)))}${headerRight}`); lines.push('━'.repeat(width));
  if (!providers.length) lines.push(color(90, '  Every account section is hidden — press v to show one.'));
  // The fixed columns after the account name, each dropped when switched off.
  const headCells = (plan: string, state: string, rank: string): string => `${on('col:plan') ? ` ${fit(plan, 10)}` : ''}${on('col:state') ? ` ${fit(state, 10)}` : ''}${on('col:order') ? ` ${rank.padEnd(4)}` : ''}`;
  const headWidth = 26 + (on('col:plan') ? 11 : 0) + (on('col:state') ? 11 : 0) + (on('col:order') ? 5 : 0);
  for (const provider of providers) {
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
    const codexSlotOn = (index: number): boolean => on(index === 0 ? 'gauge:codex-1' : 'gauge:codex-2');
    // Claude folded the 5-hour session limit into the weekly one; keep the
    // session column only while some account still reports a live 5h window.
    const claudeSession = on('gauge:5h') && group.some((account) => activeWindow(state.accounts[account.credentialId]?.windows?.['5h']));
    const claudeGauges = (claudeSession ? 1 : 0) + (on('gauge:7d') ? 1 : 0) + (on('gauge:fable') ? 1 : 0);
    // The tickets column costs 8 cells: only when some account holds tickets and the row still
    // fits — head + one gauge per window + renewal and age (up to 19) + the column itself.
    const rowWithResets = headWidth + claudeGauges * (barWidth + 1) + (on('col:renewal') ? 7 : 0) + (on('col:age') ? 12 : 0) + 8;
    const showResets = provider === 'claude' && on('gauge:resets') && rowWithResets <= width && group.some((account) => resetTickets(state.accounts[account.credentialId]?.resetCredits) !== '');
    const usageTitles = provider === 'claude'
      ? `${claudeSession ? slot('5h session') : ''}${on('gauge:7d') ? slot('7d overall') : ''}${on('gauge:fable') ? slot('7d Fable') : ''}${showResets ? ` ${fit('resets', 7)}` : ''}`
      : Array.from({ length: codexWindowCount }, (_, index) => index).filter(codexSlotOn).map((index) => slot(spanAt(index))).join('');
    lines.push(color(90, fit(`  ${fit('account', 24)}${headCells('plan', 'state', 'order')}${usageTitles}`, width)));
    for (const account of group) {
      const saved = state.accounts[account.credentialId]; const profile = saved?.profile; const cursor = account.credentialId === selectedId ? color(36, '>') : ' '; const enabled = account.enabled ? (saved?.error ? color(31, 'error') : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? color(33, 'cooldown') : account.fableOnly && account.provider === 'claude' && (Object.entries(saved?.windows ?? {}).find(([name]) => /^7d_[a-z0-9]+$/i.test(name))?.[1]?.usage ?? 0) < 1 ? color(35, 'fable') : color(32, 'active')) : color(90, 'disabled'); const rank = account.priority == null ? 'auto' : `#${account.priority}`;
      const plan = provider === 'claude' && profile && !healthy(profile) ? color(31, profile.status || 'inactive') : provider === 'claude' ? claudeTier(profile) : codexPlan(profile);
      const head = `${cursor} ${fit(account.label, 24)}${headCells(plan, enabled, rank)}`;
      const measured = on('col:age') ? ` ${age(saved?.measuredAt)}` : '';
      if (provider === 'claude') {
        const session = saved?.windows?.['5h']; const weekly = saved?.windows?.['7d']; const fable = saved?.windows?.['7d_oi'] || Object.entries(saved?.windows || {}).find(([name]) => name.startsWith('7d_'))?.[1]; const renew = renewal(profile); const renewColored = renew === 'D-DAY' || /^D-[0-3]$/.test(renew) ? color(31, renew) : /^D-[4-7]$/.test(renew) ? color(33, renew) : color(32, renew);
        const gauges = [claudeSession ? bar(session?.usage, session?.resetsAt, barWidth) : '', on('gauge:7d') ? bar(weekly?.usage, weekly?.resetsAt, barWidth) : '', on('gauge:fable') ? bar(fable?.usage, fable?.resetsAt, barWidth) : ''].filter(Boolean).map((gauge) => ` ${gauge}`).join('');
        lines.push(`${head}${gauges}${showResets ? ` ${color(resetTicketsStale(saved?.resetCredits) ? 90 : 36, fit(resetTickets(saved?.resetCredits), 7))}` : ''}${on('col:renewal') ? ` ~${renewColored}` : ''}${measured}`);
      } else {
        const active = [saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow);
        const gauges = active.map((window, index) => (codexSlotOn(index) ? ` ${bar(window!.usage, window!.resetsAt, barWidth)}` : '')).join('');
        lines.push(`${head}${active.length ? `${gauges}${measured}` : ` ${color(90, 'no quota data yet')}`}`);
      }
    }
    lines.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  }
  if (mode === 'view') {
    // The menu takes the activity pane's place while it is open.
    // On a short terminal the account rows give way first, keeping at least a
    // few menu rows, and the menu scrolls to keep its cursor in view.
    const cursorAt = Math.max(0, Math.min(DISPLAY_ITEMS.length - 1, view.viewCursor ?? 0));
    const minMenu = Math.min(DISPLAY_ITEMS.length, 6);
    if (height !== undefined && lines.length + 4 + minMenu > height) lines.splice(Math.max(2, height - 4 - minMenu));
    const room = height === undefined ? DISPLAY_ITEMS.length : Math.max(1, height - lines.length - 4);
    const first = Math.max(0, Math.min(cursorAt - Math.floor(room / 2), DISPLAY_ITEMS.length - room));
    lines.push(''); lines.push(` Show / hide ${'─'.repeat(Math.max(0, width - 13))}`);
    DISPLAY_ITEMS.slice(first, first + room).forEach((item, offset) => {
      const mark = on(item.key) ? color(32, '[x]') : color(90, '[ ]');
      lines.push(`${first + offset === cursorAt ? color(36, '>') : ' '} ${mark} ${color(90, fit(item.group, 8))}${item.label}`);
    });
  } else if (on('activity')) {
    const activityRows = height === undefined ? 8 : Math.max(4, height - lines.length - 5); lines.push(''); lines.push(` Activity ${'─'.repeat(Math.max(0, width - 10))}`);
    for (const event of [...(state.events || [])].reverse().slice(0, activityRows)) lines.push(`${color(90, new Date(event.at).toLocaleTimeString('en-GB'))} ${event.message}`);
  }
  if (height !== undefined) while (lines.length < height - 2) lines.push('');
  lines.push('─'.repeat(width));
  const footer = mode === 'normal' ? ` 1 Claude  2 Codex  ↑↓ move  s pin  e enable  o order  d del  a add  p/P capture  R Reload  v view  c ${sortByHeadroom ? 'quota' : 'config'}-sort  q quit`
    : mode === 'order' ? ' ORDER: ↑↓ rank   a/c auto   Enter/Esc done'
      : mode === 'delete' ? ' DELETE selected account? y/Enter confirm   Esc cancel'
        : mode === 'view' ? ' VIEW: ↑↓ select   Space/Enter show/hide   Esc done'
          : ' ADD: 1 Claude login   2 Codex login   Esc cancel';
  // The message is the part that matters when there is one — a capture path,
  // a failure — so when both do not fit it is the key hints that give way.
  const status = message ? `   ${message}` : '';
  lines.push(status && footer.length + status.length > width ? `${fit(footer, Math.max(0, width - status.length))}${status}` : fit(`${footer}${status}`, width));
  return (height === undefined ? lines : lines.slice(0, height)).map((line) => fit(line, width));
}
