// Account labels are almost always email addresses, and a dashboard capture is
// something people paste into an issue or a chat. Masking happens on the data
// before the frame is drawn — labels in config, messages in the event log —
// so the three places a label reaches the screen (the account column, the
// footer message, the activity pane) are covered by one pass rather than by
// three patches that must each remember the same rule.
import { parseGroups } from './groups.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from './types.js';

export type RedactLevel = 'partial' | 'full' | 'none';
export const REDACT_LEVELS: readonly RedactLevel[] = ['partial', 'full', 'none'];
export function isRedactLevel(value: string): value is RedactLevel { return (REDACT_LEVELS as readonly string[]).includes(value); }

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Keep the first two and the last character so the owner still recognises
// which account a row is, while nobody else can read the address off it.
function maskPart(text: string): string {
  if (text.length <= 3) return '•'.repeat(Math.max(1, text.length));
  return `${text.slice(0, 2)}${'•'.repeat(text.length - 3)}${text.slice(-1)}`;
}

function maskDomain(domain: string): string {
  const dot = domain.lastIndexOf('.');
  if (dot <= 0) return maskPart(domain);
  const name = domain.slice(0, dot);
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, name.length - 2))}${domain.slice(dot)}`;
}

export function maskLabel(label: string, level: RedactLevel, index: number): string {
  if (level === 'none') return label;
  if (level === 'full') return `account #${index + 1}`;
  const at = label.indexOf('@');
  return at > 0 ? `${maskPart(label.slice(0, at))}@${maskDomain(label.slice(at + 1))}` : maskPart(label);
}

// A function that masks every known label inside free text — event messages
// embed labels in longer sentences — longest label first so that one address
// that is a prefix of another cannot leave the longer one half-masked. Any
// email-shaped text that survives (an address no longer in config, say) is
// masked too, so the sweep never depends on the config being complete.
export function redactor(accounts: StoredAccount[], level: RedactLevel): (text: string) => string {
  if (level === 'none') return (text) => text;
  const pairs = accounts
    .map((account, index) => [account.label, maskLabel(account.label, level, index)] as const)
    .filter(([label]) => label.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [label, masked] of pairs) out = out.split(label).join(masked);
    return out.replace(EMAIL, (match) => level === 'full' ? '[redacted]' : maskLabel(match, 'partial', 0));
  };
}

export function redactSnapshot(config: TeamAIConfig, state: PersistedState, level: RedactLevel): { config: TeamAIConfig; state: PersistedState } {
  if (level === 'none') return { config, state };
  const mask = redactor(config.accounts, level);
  return {
    // Route account references are usually labels too.
    config: { ...config, ...(config.groups ? { groups: parseGroups(config.groups, config.accounts) } : {}), accounts: config.accounts.map((account, index) => ({ ...account, label: maskLabel(account.label, level, index) })), ...(config.routes ? { routes: Object.fromEntries(Object.entries(config.routes).map(([provider, list]) => [provider, list?.map((route) => ({ ...route, accounts: route.accounts.map((ref) => typeof ref === 'string' ? mask(ref) : ref) }))])) } : {}) },
    state: {
      ...state,
      // Full redaction also drops session ids: they let lines be tied to one
      // conversation. Partial keeps them — the screen shows six characters.
      events: (state.events || []).map((event) => ({ ...event, message: mask(event.message), ...(event.request ? { request: { ...event.request, account: event.request.account && mask(event.request.account), ...(level === 'full' ? { sessionId: null } : {}) } } : {}) })),
      active: state.active?.map((entry) => ({ ...entry, account: entry.account && mask(entry.account), ...(level === 'full' ? { sessionId: null } : {}) })),
      // Another app's account: already masked when read, masked again here,
      // and dropped entirely under full redaction.
      ...(state.external ? { external: Object.fromEntries(Object.entries(state.external).map(([provider, usage]) => [provider, usage && { ...usage, identity: level === 'full' ? null : usage.identity && mask(usage.identity) }])) } : {}),
    },
  };
}
