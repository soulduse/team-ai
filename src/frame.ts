// The dashboard as pure text: given a config and a state, produce the lines the
// screen would show. The interactive loop in tui.ts and the file capture in
// capture.ts both draw through here, so a capture is exactly what a person at
// the terminal would have seen — same ordering, same gauges, same colors.
import { AccountPool, type Ranked as RankedAccount } from './account-pool.js';
import { cellWidth, fit, gaugeWidth, layoutRows, placeInSlots, SLOTS, usageLayout, type GridRow } from './columns.js';
import { hostText, type HostSample } from './host-metrics.js';
import { EXTERNAL_PROVIDERS, type ExternalProvider, type ExternalUsage, type ExternalWindow } from './external-usage.js';
import { comparePacing, formatDeviation, pacingDeviation, parseBalance, type Balance } from './pacing.js';
import { routeEditorFooter, routeEditorLines, type RouteEditor } from './route-editor.js';
import { groupEditorFooter, groupEditorLines, type GroupEditor } from './group-editor.js';
import { groupStatuses, parseGroups } from './groups.js';
import { routeColor } from './routes.js';
import type { ActiveRequest, ActivityEvent, PersistedState, StoredAccount, SubscriptionProfile, TeamAIConfig } from './types.js';

export const ESC = '\x1b['; const RESET = `${ESC}0m`;
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
const visible = cellWidth;

function duration(reset: number | null | undefined): string {
  if (!reset || reset <= Date.now()) return '';
  const mins = Math.ceil((reset - Date.now()) / 60_000); if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60); if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ''}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ''}`;
}

// `align` is how the label sits inside the bar. The wide layout centres it in
// the gauge; the narrow layout right-aligns it so the figure, the window name
// above it and the reset time below it all end in one column.
function bar(usage: number | null | undefined, reset: number | null | undefined, width: number, align: 'center' | 'right' = 'center'): string {
  const remaining = duration(reset); const ratio = usage == null ? null : Math.max(0, Math.min(1, usage));
  const label = ratio == null ? (remaining || '-') : `${Math.round(ratio * 100)}%${remaining && `${Math.round(ratio * 100)}% ${remaining}`.length <= width ? ` ${remaining}` : ''}`;
  const text = align === 'right' ? label.slice(0, width).padStart(width) : label.slice(0, width).padStart(Math.floor((width + label.length) / 2)).padEnd(width);
  if (ratio == null) return `${ESC}100;37m${text}${RESET}`;
  const filled = Math.round(ratio * width); const bg = ratio >= 0.9 ? 41 : ratio >= 0.7 ? 43 : 42;
  return `${ESC}${bg};97m${text.slice(0, filled)}${ESC}100;37m${text.slice(filled)}${RESET}`;
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
function tier(profile: SubscriptionProfile | null | undefined): string {
  if (!profile) return 'OAuth'; const match = /(\d+x)$/i.exec(profile.rateLimitTier || '');
  if (match) return `Max ${match[1]}`; if (profile.hasClaudeMax || profile.orgType === 'claude_max') return 'Max'; if (profile.hasClaudePro || profile.orgType === 'claude_pro') return 'Pro'; return 'OAuth';
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
// A week is always "7d", never "1w", so every panel writes it the way Claude's
// own windows do.
function windowLabel(minutes: number | null | undefined, fallback: string): string {
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// A Codex account's windows in the three gauges: a 5h limit in the session
// gauge, a 7d limit in the weekly one, whichever ChatGPT sends it as; a window
// of unknown length keeps its primary/secondary place.
function codexWindows(state: PersistedState, account: StoredAccount) {
  const saved = state.accounts[account.credentialId];
  return placeInSlots([saved?.windows?.primary || saved?.windows?.requests, saved?.windows?.secondary].filter(activeWindow), (window) => window!.minutes, (index) => index);
}

// What the account order depends on in config: routing.balance, read the same
// way the server reads it.
export interface OrderOptions { balance: Balance; now?: number }
export function orderOptions(config: Pick<TeamAIConfig, 'routing'>): OrderOptions {
  let balance: Balance; try { balance = parseBalance(config.routing?.balance); } catch { balance = 'pacing'; }
  return { balance };
}

// The base roster: providers together, then the pool's order or configured
// order inside each provider. Group sections preserve this order internally;
// navigationOrder turns those sections into the unique selection sequence.
export function displayOrder(accounts: StoredAccount[], state: PersistedState, byHeadroom: boolean, options: OrderOptions = { balance: 'pacing' }): StoredAccount[] {
  // The same order the pool gives a new non-Fable request: priority, then the
  // balance's own comparison — comparePacing, or with 'level' the pool's
  // levelOrder over the saved windows and the requests in flight — so the top row is where the green arrow points unless something
  // is unavailable.
  const now = options.now ?? Date.now();
  const windows = (account: StoredAccount) => state.accounts[account.credentialId]?.windows || {};
  const ranked = (account: StoredAccount): RankedAccount => {
    const saved = state.accounts[account.credentialId];
    const inflight = (state.active ?? []).filter((entry) => entry.provider === account.provider && entry.account === account.label).length;
    return { usage: saved?.usage ?? null, resetsAt: saved?.resetsAt ?? null, windows: windows(account), inflight };
  };
  const balanced = (provider: 'claude' | 'codex') => provider === 'codex'
    // TeamCodex's Codex order is always weekly pacing. The optional TeamAI
    // level order is kept for Claude, but must not make a Codex 5-hour window
    // outrank a less-used weekly window.
    ? (a: StoredAccount, b: StoredAccount) => comparePacing({ id: a.id, windows: windows(a) }, { id: b.id, windows: windows(b) }, false, now)
    : options.balance === 'level'
      ? ((level) => (a: StoredAccount, b: StoredAccount) => level(ranked(a), ranked(b)))(AccountPool.levelOrder(false))
      : (a: StoredAccount, b: StoredAccount) => comparePacing({ id: a.id, windows: windows(a) }, { id: b.id, windows: windows(b) }, false, now);
  const ordered: StoredAccount[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (byHeadroom) {
      group.sort((a, b) => {
        if (a.priority !== null || b.priority !== null) {
          const diff = (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER);
          if (diff !== 0) return diff;
        }
        return balanced(provider)(a, b);
      });
    }
    ordered.push(...group);
  }
  return ordered;
}

// A roster held in the order it had when the priority editor opened, so a
// priority change does not make the row being edited jump elsewhere on the
// next redraw. An account added since then joins at the end; one removed since
// then is gone, as it would be anywhere else on the dashboard.
export function frozenOrder(accounts: StoredAccount[], ids: readonly string[]): StoredAccount[] {
  const remaining = new Map(accounts.map((account) => [account.credentialId, account]));
  const ordered: StoredAccount[] = [];
  for (const id of ids) {
    const account = remaining.get(id);
    if (!account) continue;
    ordered.push(account); remaining.delete(id);
  }
  for (const account of accounts) if (remaining.delete(account.credentialId)) ordered.push(account);
  return ordered;
}

interface AccountSection { name?: string; accounts: StoredAccount[] }

// Keep the pool's order inside each configured group. Shared accounts are
// repeated in the sections, but remain one account for selection and actions.
function claudeSections(config: TeamAIConfig, ordered: StoredAccount[]): AccountSection[] {
  const accounts = ordered.filter((account) => account.provider === 'claude');
  const groups = Object.entries(parseGroups(config.groups, config.accounts));
  if (!groups.length) return [{ accounts }];
  const assigned = new Set(groups.flatMap(([, ids]) => ids));
  const sections: AccountSection[] = groups.map(([name, ids]) => ({ name, accounts: accounts.filter((account) => ids.includes(account.id)) }));
  const ungrouped = accounts.filter((account) => !assigned.has(account.id));
  if (ungrouped.length) sections.push({ name: '그룹 없음', accounts: ungrouped });
  return sections;
}

// Walk each identity once, at its first visible occurrence. Every copy of a
// shared identity shows the cursor and receives the same account action.
export function navigationOrder(config: TeamAIConfig, ordered: StoredAccount[]): StoredAccount[] {
  const seen = new Set<string>();
  return [...claudeSections(config, ordered).flatMap((section) => section.accounts), ...ordered.filter((account) => account.provider === 'codex')]
    .filter((account) => {
      if (seen.has(account.credentialId)) return false;
      seen.add(account.credentialId); return true;
    });
}

function groupSectionTitle(section: AccountSection, summaries: ReturnType<typeof groupStatuses>): string | undefined {
  if (section.name === undefined) return undefined;
  const summary = summaries.find((group) => group.name === section.name);
  return summary ? `${summary.name} · ${summary.ready}/${summary.ids.length} ready · headroom ${summary.headroom.toFixed(2)}${summary.unknown ? ` + ${summary.unknown} unknown` : ''}` : section.name;
}

function sharedAccounts(sections: AccountSection[]): Set<string> {
  const seen = new Set<string>(); const shared = new Set<string>();
  for (const account of sections.flatMap((section) => section.accounts)) {
    if (seen.has(account.credentialId)) shared.add(account.credentialId);
    seen.add(account.credentialId);
  }
  return shared;
}

// Braille spinner for requests still in flight. The frame is derived from the
// clock, so the 500ms redraw animates it with no state of its own.
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const clock = (at: number): string => color(90, new Date(at).toLocaleTimeString('en-GB'));

// A session's tag: the first six characters of its id, in a colour fixed by
// the id, so one conversation's lines can be followed down the log. Red (an
// error) and grey (the clock) are left out of the palette.
const SESSION_COLORS = [36, 35, 34, 33, 94, 95, 96, 93, 92];
function sessionTag(id: string): string {
  let hash = 0; for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return color(SESSION_COLORS[hash % SESSION_COLORS.length]!, id.slice(0, 6).padEnd(6));
}

// " (model·effort)", the effort in a quieter grey.
function modelText(model: string | null | undefined, effort: string | null | undefined, dim: boolean): string {
  if (!model) return '';
  const name = dim ? color(2, model) : model;
  return ` (${name}${effort ? `${ESC}38;5;244m·${effort}${RESET}` : ''})`;
}

// In-flight requests first, in the order they started, then the log newest
// first. A finished request is drawn from its structured fields so the status
// and duration read the same on every line; anything else is its sentence.
// The session column is there only when some request line has a session, and
// then it is six wide on every request line so methods stay aligned.
function activityLines(active: ActiveRequest[], events: ActivityEvent[], rows: number, show: { sessionIds: boolean; models: boolean }, tint: (provider: string, route: string) => number): string[] {
  const now = Date.now(); const spin = SPINNER[Math.floor(now / 500) % SPINNER.length]!;
  const shownActive = active.slice(0, rows); const shownEvents = [...events].reverse().slice(0, Math.max(0, rows - shownActive.length));
  const tagged = show.sessionIds && [...shownActive, ...shownEvents.map((e) => e.request)].some((r) => r?.sessionId);
  const tag = (id: string | null | undefined): string => tagged ? `${id ? sessionTag(id) : ' '.repeat(6)} ` : '';
  const model = (r: { model?: string | null; effort?: string | null }, dim: boolean): string => show.models ? modelText(r.model, r.effort, dim) : '';
  const routed = (r: { provider: string; route?: string | null; routeFallback?: boolean; group?: string | null }): string => (r.group ? ` [group:${r.group}]` : '') + (r.route ? ` ${color(tint(r.provider, r.route), `[route:${r.route}${r.routeFallback ? '→fallback' : ''}]`)}` : '');
  const out = shownActive.map((entry) => {
    const account = entry.account ? ` → ${entry.account}` : '';
    return `${color(36, spin)} ${clock(entry.startedAt)}  ${tag(entry.sessionId)}${entry.providerLabel} ${entry.method} ${entry.path}${model(entry, true)}${account}${routed(entry)}${entry.capacityRetries ? color(33, ` capacity retry x${entry.capacityRetries}`) : ''} ${color(2, `(${(Math.max(0, now - entry.startedAt) / 1000).toFixed(1)}s...)`)}`;
  });
  for (const event of shownEvents) {
    const request = event.request;
    if (!request) { out.push(`  ${clock(event.at)}  ${event.message}`); continue; }
    const failed = typeof request.status !== 'number' || request.status >= 400 || Boolean(request.streamEnd);
    const outcome = `(${request.status}${request.streamEnd ? ` ${request.streamEnd}` : ''}, ${(request.durationMs / 1000).toFixed(1)}s)`;
    out.push(`  ${clock(event.at)}  ${tag(request.sessionId)}${request.providerLabel} ${request.method} ${request.path}${model(request, false)}${request.account ? ` → ${request.account}` : ''}${routed(request)}${request.capacityRetries ? color(33, ` capacity retry x${request.capacityRetries}`) : ''} ${failed ? color(31, outcome) : outcome}`);
  }
  return out;
}

// Another agent's window as the screen names it: by its length like every
// other gauge, so a week reads "7d". The stored label ('wk', or Orca's
// 'weekly' when it sends no length) is kept as is for saved state.
const externalLabel = (window: ExternalWindow): string => windowLabel(window.minutes, /^(wk|weekly)$/i.test(window.label) ? '7d' : window.label);

const EXTERNAL_TITLES: Record<ExternalProvider, string> = { antigravity: 'Antigravity (agy)', opencodeGo: 'OpenCode Go', grok: 'Grok', commandCode: 'Command Code' };

// One provider's box: a row per usage group, its windows as the same gauges
// the accounts use (same colour steps, so the screen reads one way), or a
// grey line saying why there is nothing to show. A failed refresh keeps the
// last good gauges for a while, labelled as cached. The gauges sit in the
// account rows' columns: a 5h window under the session gauge, a weekly one
// under the weekly gauge (Grok's only window included), a 30-day one under
// the extra gauge, and a window of unknown length there too.
function externalBox(usage: ExternalUsage, width: number, gauge: number): Array<string | GridRow> {
  const title = ` ${EXTERNAL_TITLES[usage.provider]} `;
  const out: Array<string | GridRow> = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - visible(title) - 3))}┐`)];
  const placed = new Map(usage.groups.map((group) => [group, placeInSlots(group.windows, (w) => w.minutes, () => SLOTS - 1)]));
  // Each gauge is titled with the length of the first window drawn in it
  // ("5h", "7d", "30d"); a gauge no group uses has no title.
  const titles = Array.from({ length: SLOTS }, (_, slot) => usage.groups.map((group) => placed.get(group)![slot]).find(Boolean)).map((window) => window && externalLabel(window));
  const name = (group: string): string => !usage.identity || usage.provider === 'antigravity' ? group : usage.provider === 'opencodeGo' ? `${group} (${usage.identity})` : `${group} ${usage.identity}`;
  const problem = usage.status === 'ok' ? null
    : usage.status === 'signed-out' ? (usage.note ?? 'not signed in') : usage.status === 'expired' ? (usage.note ?? 'sign-in expired')
    : usage.status === 'unavailable' ? (usage.note ?? 'usage unavailable') : `${usage.note ?? 'error'}`;
  if (titles.some(Boolean)) {
    out.push({ identity: '  group', cells: titles, dim: true });
    for (const group of usage.groups) {
      const gauges = placed.get(group)!.map((w) => w && bar(w.usedPercent === null ? null : w.usedPercent / 100, w.resetsAt, gauge));
      out.push({ identity: `  ${name(group.name)}`, cells: gauges, tail: [age(usage.lastOkAt)] });
    }
    if (problem) out.push(color(90, `  refresh failed — showing cached data (${problem})`));
  } else out.push(color(90, `  ${problem ?? (usage.measuredAt ? 'no usage data' : 'not measured yet')}`));
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out;
}

export type FrameMode = 'normal' | 'order' | 'delete' | 'add' | 'credits' | 'routes' | 'groups' | 'help';

// The reset-credit picker ('t' on a Codex row): the tickets on one account and
// where the operator is in choosing and confirming one.
export interface CreditPicker {
  account: string;
  phase: 'loading' | 'pick' | 'confirm' | 'applying' | 'done';
  items: Array<{ title: string | null; grantedAt: number | null; expiresAt: number | null }>;
  index: number;
  result?: string;
}

function stamp(at: number | null): string {
  if (!at) return '—'; const d = new Date(at); const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pickerLines(picker: CreditPicker, width: number): string[] {
  const title = ` Reset credits — ${picker.account} `;
  const out = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - visible(title) - 3))}┐`)];
  if (picker.phase === 'loading') out.push(color(90, '  Loading…'));
  else if (!picker.items.length) out.push(color(90, '  No reset credits available'));
  // Narrower than the wide layout, a ticket is its title and when it expires.
  else picker.items.forEach((item, i) => out.push(width < NARROW_WIDTH
    ? `${i === picker.index ? color(36, '>') : ' '} ${fit(item.title ?? '(untitled)', Math.max(4, width - 18))} exp ${stamp(item.expiresAt)}`
    : `${i === picker.index ? color(36, '>') : ' '} ${fit(item.title ?? '(untitled)', 28)} granted ${stamp(item.grantedAt)}  expires ${stamp(item.expiresAt)}`));
  if (picker.phase === 'applying') out.push(color(33, '  Applying…'));
  if (picker.phase === 'done') out.push(`  Result: ${picker.result ?? 'error'}`);
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out;
}

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
  credits?: CreditPicker;
  routes?: RouteEditor;
  groups?: GroupEditor;
  // This PC's CPU and RAM load, sampled by the caller on each redraw. Absent:
  // the header has no host field at all.
  host?: HostSample | null;
  // The account order to hold while the priority editor is open, captured when
  // it opened. Ignored in every other mode, so leaving the editor returns to
  // the live display order.
  frozen?: readonly string[];
}

// The order one frame draws: the frozen roster while priority mode holds it,
// else the live display order.
function frameOrder(config: TeamAIConfig, state: PersistedState, view: FrameView): StoredAccount[] {
  return view.mode === 'order' && view.frozen ? frozenOrder(config.accounts, view.frozen) : displayOrder(config.accounts, state, view.sortByHeadroom, orderOptions(config));
}

// The header's right side: the first candidate that fits beside the title
// with a space to spare, else the last one. Candidates go from most to least
// detailed, and the host field (CPU/RAM) goes before anything else does —
// its used/total amount first, then the whole field, and only then the ports.
function headerLine(left: string, candidates: string[], width: number): string {
  const right = candidates.find((text) => visible(left) + 1 + visible(text) <= width) ?? candidates[candidates.length - 1] ?? '';
  return `${left}${' '.repeat(Math.max(1, width - visible(left) - visible(right)))}${right}`;
}
// The used/total amount is for the wide layout only.
const withHost = (host: HostSample | null | undefined, rest: string, amounts: boolean): string[] => host ? [...(amounts ? [hostText(host, true)] : []), hostText(host, false)].map((text) => (rest ? `${text}  ${rest}` : `${text} `)) : [];

// Every key the normal screen takes, as the footer names them. The wide footer
// spells them out in one line; a narrow one shows what fits and leaves the
// rest to the '?' list.
export function normalKeys(codexSelected: boolean, sortByHeadroom: boolean): string[] {
  return ['↑↓ select', 's switch', 'e enable', 'o order', 'd delete', 'a add', ...(codexSelected ? ['t credits'] : []), 'p capture', 'R Reload', `c ${sortByHeadroom ? 'quota' : 'config'}-sort`, 'g routes', 'q quit'];
}

// Hints packed into as few lines of `width` as they fit, two spaces apart.
function packHints(hints: string[], width: number): string[] {
  const out: string[] = []; let line = '';
  for (const hint of hints) {
    const next = line ? `${line}  ${hint}` : ` ${hint}`;
    if (line && visible(next) > width) { out.push(line); line = ` ${hint}`; } else line = next;
  }
  if (line) out.push(line);
  return out;
}

// The '?' list: every key, in either layout.
function helpLines(keys: string[], width: number): string[] {
  const title = ' Keys ';
  const body = packHints([...keys, 'G groups', '? this list'], Math.max(1, width - 2))
    .map((line) => color(36, `│${fit(line, Math.max(0, width - 2))}│`));
  return [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - visible(title) - 3))}┐`), ...body, color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`)];
}

export function buildFrame(config: TeamAIConfig, state: PersistedState, view: FrameView): string[] {
  const { width, height, selectedId, mode, message, sortByHeadroom } = view;
  // The route markers widen the identity column by the larger provider's
  // route count, so both account boxes keep their gauges in line.
  const markWidth = Math.max(0, ...(['claude', 'codex'] as const).map((provider) => (state.routes || []).filter((route) => route.provider === provider).length));
  if (isNarrow(width, markWidth)) return buildNarrowFrame(config, state, view);
  const accounts = config.accounts; const ordered = frameOrder(config, state, view);
  const sections = claudeSections(config, ordered); const shared = sharedAccounts(sections);
  const summaries = groupStatuses(config, state);
  const lines: Array<string | GridRow> = [];
  // One column layout for every panel below (see columns.ts): the account
  // boxes and the other agents' boxes are collected as grid rows and laid out
  // together.
  const barWidth = gaugeWidth(width);
  const headerRight = `${config.proxy.host}:${config.proxy.claudePort}/${config.proxy.codexPort} `;
  lines.push(headerLine(color(1, ' TeamAI'), [...withHost(view.host, headerRight, true), headerRight], width)); lines.push('━'.repeat(width));
  for (const provider of ['claude', 'codex'] as const) {
    const group = ordered.filter((account) => account.provider === provider); if (!group.length) continue;
    const sectionTitle = ` ${provider === 'claude' ? 'Claude' : 'Codex'} accounts (${group.length}) `;
    lines.push(color(36, `┌─${sectionTitle}${'─'.repeat(Math.max(0, width - sectionTitle.length - 3))}┐`));
    // Column titles: the rows are dense and every field below is an
    // abbreviation, so name them once per section rather than expecting the
    // reader to infer what "auto" or a bare percentage refers to.
    const codexSlots = (account: StoredAccount) => codexWindows(state, account);
    // Codex titles follow whatever windows are actually in play for this
    // section, so the header never advertises a gauge that no row renders.
    // Window lengths vary by account, so the title is the span the rows no
    // longer repeat ("5h", "7d", as on Claude's side); fall back to a neutral
    // name when they disagree.
    const spanAt = (slot: number): string => {
      const windows = group.map((account) => codexSlots(account)[slot]).filter(Boolean);
      if (!windows.length) return '';
      const seen = new Set(windows.map((window) => windowLabel(window!.minutes, '')).filter(Boolean));
      return seen.size === 1 ? [...seen][0]! : ['usage limit', 'second limit', 'third limit'][slot]!;
    };
    const usageTitles = provider === 'claude' ? ['5h session', '7d', '7d Fable'] : Array.from({ length: SLOTS }, (_, slot) => spanAt(slot));
    // One marker column per model route, left of the cursor: the route's
    // colour on its accounts, grey where that account cannot serve now. No
    // routes, no columns — the rows are then exactly as before.
    const routes = (state.routes || []).filter((route) => route.provider === provider);
    // Where a new request would go (state.next, from the server): a green ►
    // after the cursor, a magenta one before the Fable gauge, and a bold
    // route marker for each route's own target.
    const next = state.next?.[provider];
    const marks = (account: StoredAccount): string => ' '.repeat(markWidth - routes.length) + routes.map((route) => {
      const member = route.members.find((m) => m.credentialId === account.credentialId);
      if (!member) return ' ';
      const target = next?.routes?.[route.name] === account.credentialId;
      return `${ESC}${target ? '1;' : ''}${member.usable ? routeColor(route.color) : 90}m▸${RESET}`;
    }).join('');
    const arrow = (account: StoredAccount): string => next?.general === account.credentialId ? color(32, '►') : ' ';
    lines.push({ identity: { lead: '', account: 'account', plan: 'plan', state: 'state', order: 'order' }, cells: usageTitles, dim: true });
    for (const section of provider === 'claude' ? sections : [{ accounts: group }]) {
      const title = groupSectionTitle(section, summaries);
      if (title) lines.push(color(36, fit(`  ${title}`, width)));
      for (const account of section.accounts) {
        const saved = state.accounts[account.credentialId]; const profile = saved?.profile; const cursor = account.credentialId === selectedId ? color(36, '>') : ' '; const enabled = account.enabled ? (saved?.error ? color(31, 'error') : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? color(33, 'cooldown') : color(32, 'active')) : color(90, 'disabled'); const rank = account.priority == null ? 'auto' : `#${account.priority}`;
        const plan = provider === 'claude' && profile && !healthy(profile) ? color(31, profile.status || 'inactive') : provider === 'claude' ? tier(profile) : codexPlan(profile);
        const head = { lead: `${marks(account)}${cursor}${arrow(account)}`, account: `${shared.has(account.credentialId) ? '↔ ' : ''}${account.label}`, plan, state: enabled, order: rank };
        // Weekly progress against the straight line: -30%p is behind (goes
        // first), +12%p ahead. Blank without a weekly window that resets later.
        const pace = formatDeviation(pacingDeviation(saved?.windows || {}, false, Date.now()));
        const paceText = pace ? color(90, pace) : '';
        if (provider === 'claude') {
          const session = saved?.windows?.['5h']; const weekly = saved?.windows?.['7d']; const fable = saved?.windows?.['7d_oi'] || Object.entries(saved?.windows || {}).find(([name]) => name.startsWith('7d_'))?.[1];
          const gauges = [bar(session?.usage, session?.resetsAt, barWidth), bar(weekly?.usage, weekly?.resetsAt, barWidth), bar(fable?.usage, fable?.resetsAt, barWidth)];
          const credits = typeof saved?.resetCredits === 'number' && saved.resetCredits > 0 ? color(36, `RC${saved.resetCredits}`) : '';
          lines.push({ identity: head, cells: gauges, tail: [age(saved?.measuredAt), paceText, credits], gaps: ['', '', next?.fable === account.credentialId ? color(35, '►') : ''] });
        } else {
          const shown = codexSlots(account);
          // Reset credits on hand, when the usage endpoint has counted some.
          const credits = typeof saved?.resetCredits === 'number' && saved.resetCredits > 0 ? color(36, `RC${saved.resetCredits}`) : '';
          lines.push(shown.some(Boolean)
            ? { identity: head, cells: shown.map((window) => window && bar(window.usage, window.resetsAt, barWidth)), tail: [age(saved?.measuredAt), paceText, credits] }
            : { identity: head, cells: color(90, 'no quota data yet'), tail: ['', '', credits] });
        }
      }
    }
    lines.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  }
  // Other agents' usage, one box each, after the relayed accounts. In a live
  // view a box is left out when it would squeeze the activity pane below its
  // minimum; a provider that is not installed has no entry and no box.
  for (const provider of EXTERNAL_PROVIDERS) {
    const usage = state.external?.[provider]; if (!usage) continue;
    const box = externalBox(usage, width, barWidth);
    if (height !== undefined && lines.length + box.length + 5 + 4 > height) continue;
    lines.push(...box);
  }
  if (mode === 'credits' && view.credits) lines.push(...pickerLines(view.credits, width));
  if (mode === 'routes' && view.routes) lines.push(...routeEditorLines(view.routes, width));
  if (mode === 'groups' && view.groups) lines.push(...groupEditorLines(view.groups, width));
  // 't' only does something on a Codex or Claude row, so it is only offered there.
  const creditSelected = accounts.some((account) => account.credentialId === selectedId && (account.provider === 'codex' || account.provider === 'claude'));
  if (mode === 'help') lines.push(...helpLines(normalKeys(creditSelected, sortByHeadroom), width));
  const activityRows = height === undefined ? 8 : Math.max(4, height - lines.length - 5); lines.push('');
  const active = state.active || [];
  const activityTitle = ` Activity${active.length ? `  ${color(36, `${active.length} active`)}` : ''} `;
  lines.push(`${activityTitle}${'─'.repeat(Math.max(0, width - visible(activityTitle)))}`);
  const tint = (provider: string, name: string): number => routeColor(config.routes?.[provider as 'claude' | 'codex']?.find((route) => route.name === name)?.color);
  lines.push(...activityLines(active, state.events || [], activityRows, { sessionIds: config.activity?.sessionIds !== false, models: config.activity?.models !== false }, tint));
  if (height !== undefined) while (lines.length < height - 2) lines.push('');
  lines.push('─'.repeat(width));
  const footer = modeFooter(view, creditSelected);
  // The message is the part that matters when there is one — a capture path,
  // a failure — so when both do not fit it is the key hints that give way.
  const status = message ? `   ${message}` : '';
  lines.push(status && visible(footer) + visible(status) > width ? `${fit(footer, Math.max(0, width - visible(status)))}${status}` : fit(`${footer}${status}`, width));
  const drawn = layoutRows(width, markWidth, lines);
  // Too short for everything: the rule and footer stay, the body gives way.
  return (height === undefined || drawn.length <= height ? drawn : [...drawn.slice(0, Math.max(0, height - 2)), ...drawn.slice(-Math.min(2, height))]).map((line) => fit(line, width));
}

function modeFooter(view: FrameView, creditSelected: boolean): string {
  const { mode } = view;
  return mode === 'routes' && view.routes ? routeEditorFooter(view.routes) : mode === 'groups' && view.groups ? groupEditorFooter(view.groups) : mode === 'normal' ? ` ${normalKeys(creditSelected, view.sortByHeadroom).join('  ')}` : mode === 'help' ? ' KEYS: any key closes' : mode === 'order' ? ' ORDER: ←→ rank -/+   ↑↓ select   a/c auto   Enter/Esc done' : mode === 'delete' ? ' DELETE selected account? y/Enter confirm   Esc cancel' : mode === 'add' ? ' ADD: 1 Claude login   2 Codex login   Esc cancel'
    : view.credits?.phase === 'confirm' ? ` Reset ${view.credits.account}'s usage with this credit? (y/n)`
    : view.credits?.phase === 'done' ? ' Esc close' : ' CREDITS: ↑↓ select   Enter use   Esc close';
}

// ── The narrow layout ───────────────────────────────────────────────────────
// A phone looking at the same terminal is 40–60 columns wide. The wide grid
// cannot draw there: identity (29 columns plus a 10-column account name plus
// the route markers) and three 12-column gauges need 78 columns before the
// third gauge is cut, and below that every row is cut mid-gauge. So under
// NARROW_WIDTH, or wherever the grid would not fit, the screen is a summary:
// one line per account and per usage group, an activity log of one line per
// request, and a footer of the keys that fit.
export const NARROW_WIDTH = 80;
export const isNarrow = (width: number, marks = 0): boolean => width < Math.max(NARROW_WIDTH, usageLayout(0, marks).tail - 1);

// One quota window on a narrow row: how much is spent and when it resets. The
// window's name is drawn once in the section rule above, not on every row.
interface Reading { usage: number | null | undefined; resetsAt: number | null | undefined }
interface NarrowRow { lead: string; name: string; tint?: number; cells: Array<Reading | undefined>; note?: string }
// A section rule that doubles as the column header: the window names sit on
// the right of the rule, over the figures, so the section costs no extra row.
interface NarrowRule { title: string; short?: string; labels: string[] }
// `stacked` is the two-line account row: the figures on the first line and
// each window's reset time on a second one, directly below its own column. A
// terminal too short for that keeps the older one-line row with a single
// reset column on the right (`reset`).
interface NarrowLayout { name: number; gauge: number; cells: number; reset: boolean; stacked: boolean }
const RESET_WIDTH = 5;
// A reset time in at most `width` columns (five by default): 59m, 2h10m, 23h,
// 3d8h, 13d. A narrow gauge field takes the leading span only ("2h").
function shortDuration(reset: number | null | undefined, width = RESET_WIDTH): string {
  const text = duration(reset); return text.length <= width ? text : text.replace(/^(\d+[hd]).*$/, '$1').slice(0, width);
}

// The richest row that still leaves the name 14 columns. The old table spent
// 1+label+1 on every cell; with the names moved to the section rule that
// width goes to the gauges and the name instead, so 40 columns now draws three
// bars where the repeated labels used to force two bare percentages, and the
// account label keeps more of itself at the same time. The two-line layout
// needs no reset column: its width goes to the gauges and the name. The third
// window (Claude's Fable week, a 30-day limit) goes before the name. One
// layout for the whole frame, so every panel's numbers line up.
function narrowLayout(width: number, needed: number, stacked: boolean): NarrowLayout {
  const cellWidth = (gauge: number): number => 1 + Math.max(4, gauge);
  const tries: Array<[number, number, boolean]> = stacked
    ? [[10, 3, false], [8, 3, false], [6, 3, false], [4, 3, false], [0, 3, false], [0, 2, false]]
    : [[10, 3, true], [8, 3, true], [6, 3, true], [4, 3, true], [0, 3, true], [0, 2, true], [0, 2, false]];
  for (const [gauge, cells, reset] of tries) {
    const shown = Math.min(cells, needed);
    const name = width - 2 - shown * cellWidth(gauge) - (reset ? 1 + RESET_WIDTH : 0);
    if (name >= 14) return { name, gauge, cells: shown, reset, stacked };
  }
  const cells = Math.min(2, needed);
  return { name: Math.max(1, width - 2 - cells * cellWidth(0)), gauge: 0, cells, reset: false, stacked };
}

function narrowValue(reading: Reading, gauge: number): string {
  if (gauge) return bar(reading.usage, null, gauge, 'right');
  if (reading.usage == null) return color(90, '   -');
  const ratio = Math.max(0, Math.min(1, reading.usage));
  return color(ratio >= 0.9 ? 31 : ratio >= 0.7 ? 33 : 32, `${Math.round(ratio * 100)}%`.padStart(4));
}

function narrowRow(layout: NarrowLayout, row: NarrowRow): string {
  const field = Math.max(4, layout.gauge);
  let out = `${fit(row.lead, 2)}${fit(row.tint ? color(row.tint, row.name) : row.name, layout.name)}`;
  const span = layout.cells * (1 + field) + (layout.reset ? 1 + RESET_WIDTH : 0);
  if (row.note) return `${out} ${fit(color(90, row.note), span - 1)}`;
  const shown = row.cells.slice(0, layout.cells);
  // One field per gauge, right-aligned, so the % signs line up.
  for (const reading of shown) out += reading ? ` ${narrowValue(reading, layout.gauge)}` : ' '.repeat(1 + field);
  out += ' '.repeat(Math.max(0, layout.cells - shown.length) * (1 + field));
  if (layout.reset) {
    // The reset that matters is the most-spent window's: that is when the
    // account gets room back.
    const binding = shown.filter((reading): reading is Reading => Boolean(reading?.resetsAt && reading.resetsAt > Date.now()))
      .sort((a, b) => (b.usage ?? -1) - (a.usage ?? -1))[0];
    out += ` ${fit(color(90, binding ? shortDuration(binding.resetsAt) : ''), RESET_WIDTH)}`;
  }
  return out;
}

// A row gets the second line only when at least one of its windows still has
// a reset ahead; a row with no figures, or with figures whose windows have
// already reset, keeps its single line.
function hasReset(row: NarrowRow): boolean {
  return !row.note && row.cells.some((cell) => cell?.resetsAt != null && cell.resetsAt > Date.now());
}

// The second line of a stacked row: each window's reset time under its own
// gauge, in the same columns, so the bar above and the time below read as one
// cell. A window without a reset leaves its field blank. The whole line is
// dim: it belongs to the account row above it, not to a row of its own.
function narrowResetRow(layout: NarrowLayout, row: NarrowRow): string | null {
  if (!layout.stacked || !hasReset(row)) return null;
  const field = Math.max(4, layout.gauge);
  let out = ' '.repeat(2 + layout.name);
  for (let i = 0; i < layout.cells; i++) {
    const cell = row.cells[i];
    const time = cell ? shortDuration(cell.resetsAt, field) : '';
    out += ` ${' '.repeat(Math.max(0, field - time.length))}${time}`;
  }
  return color(90, out);
}

const rule = (title: string, width: number): string => { const head = visible(`─ ${title} `) > width ? fit(`─ ${title} `, width) : `─ ${title} `; return color(36, `${head}${'─'.repeat(Math.max(0, width - visible(head)))}`); };

// Right-align a window name in its gauge field, so its last column is the
// same one the figure and the reset time end in.
function right(text: string, width: number): string {
  const label = text.slice(0, width);
  return fit(`${' '.repeat(Math.max(0, width - visible(label)))}${label}`, width);
}

// The section rule doubles as the column header. Its left side stays the name
// and count a person scans for; the window names sit at the same columns as
// the gauges below, written once per section instead of on every account row.
function narrowRule(layout: NarrowLayout, marker: NarrowRule, width: number): string {
  const field = Math.max(4, layout.gauge);
  const prefix = 2 + layout.name;
  const labels = marker.labels.slice(0, layout.cells);
  if (!labels.some(Boolean)) return rule(marker.title, width);
  const head = (title: string): string => `─ ${title} `;
  let title = marker.title;
  if (visible(head(title)) > prefix) title = marker.short ?? title;
  if (visible(head(title)) > prefix) return rule(marker.title, width);
  let out = color(36, `${head(title)}${'─'.repeat(Math.max(0, prefix - visible(head(title))))}`);
  for (let i = 0; i < layout.cells; i++) out += color(90, ` ${right(labels[i] ?? '', field)}`);
  if (layout.reset) out += color(90, ` ${fit('reset', RESET_WIDTH)}`);
  return fit(out, width);
}

const hhmm = (at: number): string => color(90, new Date(at).toLocaleTimeString('en-GB').slice(0, 5));

// One line per request, never wrapped: time, session, provider (C/X),
// status — seconds so far while in flight — and the account, cut to fit.
function narrowActivity(active: ActiveRequest[], events: ActivityEvent[], rows: number, width: number, sessions: boolean): string[] {
  const now = Date.now(); const spin = SPINNER[Math.floor(now / 500) % SPINNER.length]!;
  const shownActive = active.slice(0, rows); const shownEvents = [...events].reverse().slice(0, Math.max(0, rows - shownActive.length));
  const tagged = sessions && [...shownActive, ...shownEvents.map((e) => e.request)].some((r) => r?.sessionId);
  const tag = (id: string | null | undefined): string => tagged ? `${id ? sessionTag(id) : ' '.repeat(6)} ` : '';
  const who = (provider: string): string => provider === 'claude' ? 'C' : provider === 'codex' ? 'X' : provider.slice(0, 1).toUpperCase();
  // The account column is the last one, so a full address that does not fit
  // would only lose its domain's tail. Keep the local part instead: it names
  // the account, while the list above still shows the fuller label.
  const account = (label: string | null | undefined, room: number): string => {
    if (!label) return '';
    if (visible(label) <= room) return label;
    const at = label.indexOf('@');
    return at > 0 && visible(label.slice(0, at)) <= room ? label.slice(0, at) : label;
  };
  const out = shownActive.map((entry) => {
    const seconds = Math.max(0, Math.round((now - entry.startedAt) / 1000));
    const elapsed = (seconds < 100 ? `${seconds}s` : `${Math.round(seconds / 60)}m`).padStart(3);
    const head = `${color(36, spin)}${hhmm(entry.startedAt)} ${tag(entry.sessionId)}${who(entry.provider)} ${color(2, elapsed)} ${entry.capacityRetries ? color(33, `retry x${entry.capacityRetries} `) : ''}${entry.group ? `[group:${entry.group}] ` : ''}`;
    return fit(`${head}${account(entry.account, width - visible(head))}`, width);
  });
  for (const event of shownEvents) {
    const request = event.request;
    if (!request) { out.push(fit(` ${hhmm(event.at)} ${event.message}`, width)); continue; }
    const failed = typeof request.status !== 'number' || request.status >= 400 || Boolean(request.streamEnd);
    const status = String(request.status).padStart(3);
    const head = ` ${hhmm(event.at)} ${tag(request.sessionId)}${who(request.provider)} ${failed ? color(31, status) : status} ${request.capacityRetries ? color(33, `retry x${request.capacityRetries} `) : ''}${request.group ? `[group:${request.group}] ` : ''}`;
    out.push(fit(`${head}${account(request.account, width - visible(head))}`, width));
  }
  return out;
}

// A line and how much it matters. When the terminal is too short for all of
// them the lowest rank goes first, from the bottom up, so what is left is
// still in screen order: the account the next request would use (and the
// selected one) outlasts everything, then the provider rules, the footer, an
// open editor, the other accounts, the header, the first activity lines
// (then the Activity rule over them, which says nothing on its own), the
// other agents, and last the rest of the activity log.
const RANK = { current: 100, provider: 90, message: 80, footer: 70, overlay: 60, account: 50, header: 45, activity: 40, activityTitle: 39, external: 30, log: 20 } as const;
interface Ranked { text: string | NarrowRow | NarrowRule; rank: number; section?: AccountSection; heading?: boolean }

function buildNarrowFrame(config: TeamAIConfig, state: PersistedState, view: FrameView): string[] {
  const { width, height, selectedId, mode, message, sortByHeadroom } = view;
  const accounts = config.accounts; const ordered = frameOrder(config, state, view);
  const sections = claudeSections(config, ordered); const shared = sharedAccounts(sections);
  const summaries = groupStatuses(config, state);
  const lines: Ranked[] = []; const push = (rank: number, ...texts: Array<string | NarrowRow | NarrowRule>): void => { for (const text of texts) lines.push({ text, rank }); };
  // How many rows the account list itself would take with the second lines,
  // used to decide whether this terminal is tall enough for them.
  let accountPhysical = 0;
  push(RANK.header, headerLine(color(1, ' TeamAI'), [...withHost(view.host, '', false), ''], width));

  for (const provider of ['claude', 'codex'] as const) {
    const group = ordered.filter((account) => account.provider === provider); if (!group.length) continue;
    const next = state.next?.[provider];
    // The names sit on the section rule instead of on every row. Claude's are
    // fixed; Codex titles follow the windows actually in play, and disagreeing
    // spans fall back to a neutral name (the same rule the wide header uses).
    const labels = provider === 'claude' ? ['5h', '7d', 'F']
      : Array.from({ length: SLOTS }, (_, slot) => {
        const spans = new Set(group.flatMap((account) => {
          const window = codexWindows(state, account)[slot];
          return window ? [windowLabel(window.minutes, '')] : [];
        }).filter(Boolean));
        return spans.size === 1 ? [...spans][0]! : spans.size > 1 ? ['usage', 'limit', 'extra'][slot]! : '';
      });
    // The ► account is always drawn; with no preview yet, the top row is the
    // best guess. The selected row stays too, so s/e/d act on something seen.
    const current = group.find((account) => account.credentialId === next?.general) ?? group[0]!;
    push(RANK.provider, { title: `${provider === 'claude' ? 'Claude' : 'Codex'} ${group.length}`, labels });
    accountPhysical += 1;
    const important = new Set<string>();
    for (const section of provider === 'claude' ? sections : [{ accounts: group }]) {
      const title = groupSectionTitle(section, summaries);
      if (title) { lines.push({ text: color(36, `  ${title}`), rank: RANK.account, section, heading: true }); accountPhysical += 1; }
      const rows = section.accounts.map((account): Ranked => {
        const saved = state.accounts[account.credentialId]; const windows = saved?.windows || {};
        const cursor = account.credentialId === selectedId ? color(36, '>') : ' ';
        const arrow = next?.general === account.credentialId ? color(32, '►') : next?.fable === account.credentialId ? color(35, '►') : ' ';
        const tint = !account.enabled ? 90 : saved?.error ? 31 : saved?.cooldownUntil && saved.cooldownUntil > Date.now() ? 33 : undefined;
        const fable = windows['7d_oi'] || Object.entries(windows).find(([name]) => name.startsWith('7d_'))?.[1];
        const cells: Array<Reading | undefined> = provider === 'claude'
          ? [pick(windows['5h']), pick(windows['7d']), pick(fable)]
          : codexWindows(state, account).map((window) => window && { usage: window.usage, resetsAt: window.resetsAt });
        const row: NarrowRow = provider === 'codex' && !cells.some(Boolean) ? { lead: `${cursor}${arrow}`, name: `${shared.has(account.credentialId) ? '↔ ' : ''}${account.label}`, tint, cells, note: 'no quota data yet' } : { lead: `${cursor}${arrow}`, name: `${shared.has(account.credentialId) ? '↔ ' : ''}${account.label}`, tint, cells };
        const keep = (account === current || account.credentialId === selectedId) && !important.has(account.credentialId);
        if (keep) important.add(account.credentialId);
        accountPhysical += hasReset(row) ? 2 : 1;
        return { text: row, rank: keep ? RANK.current : RANK.account, section };
      });
      lines.push(...rows);
    }
  }

  // 't' only does something on a Codex or Claude row, so it is only offered there.
  const creditSelected = accounts.some((account) => account.credentialId === selectedId && (account.provider === 'codex' || account.provider === 'claude'));
  let overlayPhysical = 0;
  const overlay = (texts: string[]): void => { overlayPhysical += texts.length; push(RANK.overlay, ...texts); };
  if (mode === 'credits' && view.credits) overlay(pickerLines(view.credits, width));
  if (mode === 'routes' && view.routes) overlay(routeEditorLines(view.routes, width));
  if (mode === 'groups' && view.groups) overlay(groupEditorLines(view.groups, width));
  if (mode === 'help') overlay(helpLines(normalKeys(creditSelected, sortByHeadroom), width));

  // Other agents: one line per usage group under one rule, a provider's
  // groups kept or dropped together. The group names (Gemini …, OpenCode Go,
  // Grok) already say whose they are. A group still showing cached figures
  // after a failed refresh is yellow.
  let externalRank: number = RANK.external; let ruled = false;
  let otherAgentsRule: Ranked | undefined; let externalRule: NarrowRule | undefined;
  const externalRows: Ranked[] = [];
  for (const provider of EXTERNAL_PROVIDERS) {
    const usage = state.external?.[provider]; if (!usage) continue;
    if (!ruled) {
      externalRule = { title: 'Other agents', short: 'Others', labels: [] };
      otherAgentsRule = { text: externalRule, rank: RANK.external };
      lines.push(otherAgentsRule); ruled = true;
    }
    const problem = usage.status === 'ok' ? null
      : usage.status === 'signed-out' ? (usage.note ?? 'not signed in') : usage.status === 'expired' ? (usage.note ?? 'sign-in expired')
      : usage.status === 'unavailable' ? (usage.note ?? 'usage unavailable') : `${usage.note ?? 'error'}`;
    const placed = usage.groups.map((group) => placeInSlots(group.windows, (w) => w.minutes, () => SLOTS - 1));
    for (const slots of placed) slots.forEach((window, slot) => {
      if (window && externalRule && !externalRule.labels[slot]) externalRule.labels[slot] = externalLabel(window);
    });
    const rows: NarrowRow[] = usage.groups.map((group, index) => ({
      lead: '  ', name: group.name, tint: problem ? 33 : undefined,
      cells: placed[index]!.map((w) => w && { usage: w.usedPercent === null ? null : w.usedPercent / 100, resetsAt: w.resetsAt }),
    }));
    if (!rows.length) rows.push({ lead: '  ', name: EXTERNAL_TITLES[provider], cells: [], note: problem ?? (usage.measuredAt ? 'no usage data' : 'not measured yet') });
    const rank = externalRank--;
    for (const row of rows) { const ranked = { text: row, rank }; externalRows.push(ranked); lines.push(ranked); }
  }

  const active = state.active || [];
  push(RANK.activityTitle, rule(`Activity${active.length ? ` ${active.length} active` : ''}`, width));
  const log = narrowActivity(active, state.events || [], height === undefined ? 8 : Math.max(0, height), width, config.activity?.sessionIds !== false);
  log.forEach((line, i) => push(i < 2 ? RANK.activity : RANK.log, line));

  // Keys: in the normal screen what fits, with '?' for the rest; in any
  // other mode the hints that fit, the rest above the footer.
  // Moving, switching and enabling come first: they are what a glance from
  // a phone is for. Hints are abbreviated so more of them share the line; the
  // '?' list still spells every key out.
  const compactKey = (key: string): string => key === '↑↓ select' ? '↑↓ sel' : key === 'd delete' ? 'd del' : key === 'p capture' ? 'p shot' : key.endsWith('-sort') ? key.slice(0, -5) : key;
  const firstFull = ['↑↓ select', 's switch', 'e enable', 'q quit'];
  const first = firstFull.map(compactKey);
  const footerKeys = mode === 'normal' ? [...first, ...normalKeys(creditSelected, sortByHeadroom).filter((key) => !firstFull.includes(key)).map(compactKey)] : modeFooter(view, creditSelected).trim().split(/\s{2,}/);
  const help = mode === 'normal' ? '? help' : '';
  let footer = ''; const left: string[] = [];
  for (const key of footerKeys) {
    const next = footer ? `${footer}  ${key}` : ` ${key}`;
    if (!left.length && visible(next) + (help ? 2 + visible(help) : 0) <= width) footer = next; else left.push(key);
  }
  if (help && left.length) footer = footer ? `${footer}  ${help}` : ` ${help}`;
  // Overflow hints are expendable rows. Keep them out of the footer's slot;
  // when the terminal is short enough that no separate row is available,
  // dropping them leaves the footer as the final, unambiguous line.
  if (!help && left.length) push(RANK.log, ...packHints(left, width).map((line) => color(90, line)));
  if (message) push(RANK.message, ` ${message}`);
  push(RANK.footer, footer);

  // The second line is taken only when the terminal can hold the whole
  // account list with it: the provider rules, group headings and one or two
  // lines per account, plus the header, the Activity rule, the footer, and
  // anything open above them (an editor, a footer message). A shorter screen
  // falls back to one line per account with the single reset column, so the
  // list still fits. A capture has no height and always takes two lines.
  const stacked = height === undefined || accountPhysical + 3 + overlayPhysical + (message ? 1 : 0) <= height;

  const isRule = (row: string | NarrowRow | NarrowRule): row is NarrowRule => typeof row !== 'string' && 'labels' in row;
  const isRow = (line: Ranked): line is Ranked & { text: NarrowRow } => typeof line.text !== 'string' && !isRule(line.text);
  // A stacked account row with a reset time is two lines on screen; every
  // other entry is one. Trimming and padding work on these counts, so a row
  // and the reset line under it are always kept or dropped together.
  const physical = (items: Ranked[]): number => items.reduce((count, line) => count + (stacked && isRow(line) && hasReset(line.text) ? 2 : 1), 0);

  // Drop what the height cannot hold.
  if (height !== undefined) {
    while (physical(lines) > height) {
      // A section heading travels with its surviving account rows.
      const candidates = lines.filter((line) => !line.heading);
      const lowest = Math.min(...candidates.map((line) => line.rank));
      const candidate = candidates.filter((line) => line.rank === lowest).at(-1)!;
      lines.splice(lines.indexOf(candidate), 1);
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (line.heading && !lines.some((row) => !row.heading && row.section === line.section)) lines.splice(i, 1);
      }
    }
  }
  // The other-agents rule has no meaning without at least one group below it.
  // Height trimming can remove every group while leaving the rule's higher
  // rank behind, so discard that orphan before drawing.
  if (otherAgentsRule && !externalRows.some((row) => lines.includes(row))) {
    const index = lines.indexOf(otherAgentsRule);
    if (index >= 0) lines.splice(index, 1);
  }
  // Blank rows below the activity log fill the rest of the screen, above the
  // footer.
  if (height !== undefined) while (physical(lines) < height) lines.splice(Math.max(0, lines.length - 1), 0, { text: '', rank: 0 });

  const rows = lines.map((line) => line.text);
  const readings = rows.filter((row): row is NarrowRow => typeof row !== 'string' && !isRule(row) && !row.note);
  const needed = Math.max(1, ...readings.map((row) => row.cells.reduce((last, cell, i) => cell ? i + 1 : last, 0)));
  const layout = narrowLayout(width, needed, stacked);
  const drawn: string[] = [];
  for (const row of rows) {
    if (typeof row === 'string') { drawn.push(row); continue; }
    if (isRule(row)) { drawn.push(narrowRule(layout, row, width)); continue; }
    drawn.push(narrowRow(layout, row));
    const resetLine = narrowResetRow(layout, row);
    if (resetLine) drawn.push(resetLine);
  }
  return drawn.map((line) => fit(line, width));
}

function pick(window: { usage: number | null; resetsAt: number | null } | undefined): { usage: number | null; resetsAt: number | null } {
  return { usage: window?.usage ?? null, resetsAt: window?.resetsAt ?? null };
}
