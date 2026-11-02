import type { PersistedState, StoredAccount, TeamAIConfig } from './types.js';

export type AccountGroups = Record<string, string[]>;

// Resolve references once at validation time; a label edit cannot broaden a group.
export function parseGroups(raw: unknown, accounts: StoredAccount[]): AccountGroups {
  const groups: AccountGroups = Object.create(null);
  if (raw === undefined) return groups;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('groups must be an object mapping names to Claude account lists');
  for (const [name, members] of Object.entries(raw)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) throw new Error(`Invalid group name "${name}"`);
    if (!Array.isArray(members) || !members.length || !members.every((ref) => typeof ref === 'string' && ref.trim())) throw new Error(`group ${name}: accounts must be a non-empty list of labels or ids`);
    groups[name] = [...new Set(members.map((ref: string) => {
      const candidates = accounts.filter((a) => a.provider === 'claude');
      const exact = candidates.filter((a) => a.id === ref);
      const matches = exact.length ? exact : candidates.filter((a) => a.label === ref);
      if (!matches.length) throw new Error(`group ${name}: unknown account "${ref}" among Claude accounts`);
      if (matches.length > 1) throw new Error(`group ${name}: ambiguous account "${ref}"; use its id`);
      return matches[0]!.id;
    }))];
  }
  return groups;
}

export function requireGroup(groups: AccountGroups, name: string): void {
  if (!Object.hasOwn(groups, name)) throw new Error(`Unknown Claude group "${name}"`);
}

export function claudeGroupArgs(args: string[], config: TeamAIConfig, envGroup = process.env.TEAMAI_GROUP): { args: string[]; group?: string } {
  const pass: string[] = []; let group: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { pass.push(...args.slice(i)); break; }
    if (arg !== '--group' && !arg.startsWith('--group=')) { pass.push(arg); continue; }
    if (group !== undefined) throw new Error('--group may be supplied only once');
    const value = arg === '--group' ? args[++i] : arg.slice('--group='.length);
    if (!value || value.startsWith('-')) throw new Error('--group requires a name');
    group = value;
  }
  group ??= envGroup || undefined;
  const groups = parseGroups(config.groups, config.accounts);
  if (group !== undefined) requireGroup(groups, group);
  return { args: pass, ...(group === undefined ? {} : { group }) };
}

// Headroom is remaining account-equivalents across all known quota windows.
// Unknown usage stays explicit instead of being counted as an empty account.
export function groupStatuses(config: TeamAIConfig, state: PersistedState) {
  const groups = parseGroups(config.groups, config.accounts);
  return Object.entries(groups).map(([name, ids]) => {
    let ready = 0; let headroom = 0; let unknown = 0;
    const members = ids.map((id) => {
      const account = config.accounts.find((a) => a.provider === 'claude' && a.id === id)!;
      const saved = state.accounts[account.credentialId];
      const usages = [saved?.usage, ...Object.values(saved?.windows ?? {}).map((w) => w.usage)].filter((value): value is number => typeof value === 'number');
      const remaining = usages.length ? Math.max(0, 1 - Math.max(...usages)) : null;
      const usable = account.enabled && !saved?.error && !(saved?.cooldownUntil && saved.cooldownUntil > Date.now()) && (remaining === null || remaining > 0);
      if (usable) ready++;
      if (remaining === null) unknown++; else if (account.enabled) headroom += remaining;
      return `${account.label} ${remaining === null ? '?' : `${Math.round(remaining * 100)}%`}${usable ? '' : ' unavailable'}`;
    });
    return { name, ids, ready, headroom, unknown, members };
  });
}

export function groupStatusLines(config: TeamAIConfig, state: PersistedState): string[] {
  return groupStatuses(config, state).map(({ name, ids, ready, headroom, unknown, members }) =>
    `Group ${name}: ${ready}/${ids.length} ready, headroom ${headroom.toFixed(2)} accounts${unknown ? ` + ${unknown} unknown` : ''} — ${members.join(', ')}`);
}
