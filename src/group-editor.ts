import { parseGroups, type AccountGroups } from './groups.js';
import { fit } from './columns.js';
import type { StoredAccount, TeamAIConfig } from './types.js';

/** The small, keyboard driven group editor used by the dashboard. */
export interface GroupEditor {
  groups: AccountGroups;
  accounts: StoredAccount[];
  index: number;
  accountIndex: number;
  phase: 'list' | 'name' | 'members' | 'delete';
  draft?: string;
  rename?: string;
  error?: string;
  notice?: string;
  pendingRemovals?: Array<{ group: string; accountId: string }>;
}

export interface GroupSave {
  groups: AccountGroups;
  focus: string | null;
  notice: string;
  session?: { type: 'delete'; name: string } | { type: 'rename'; from: string; to: string } | { type: 'remove-members'; removals: Array<{ group: string; accountId: string }> };
}

const UP = new Set(['\x1b[A', 'k']);
const DOWN = new Set(['\x1b[B', 'j']);
const BACKSPACE = new Set(['\x7f', '\b']);
// eslint-disable-next-line no-control-regex
const printable = (key: string): boolean => key.length > 0 && !/[\x00-\x1f\x7f]/.test(key);
const names = (editor: GroupEditor): string[] => Object.keys(editor.groups);
const allAccounts = (editor: GroupEditor): StoredAccount[] => editor.accounts;

export function openGroupEditor(config: Pick<TeamAIConfig, 'accounts' | 'groups'>, focus?: string | null, notice?: string): GroupEditor {
  const groups: AccountGroups = Object.create(null);
  for (const [name, members] of Object.entries(config.groups ?? {})) groups[name] = [...members];
  const list = Object.keys(groups);
  const index = focus ? Math.max(0, list.indexOf(focus)) : 0;
  return { groups, accounts: [...config.accounts], index, accountIndex: 0, phase: 'list', ...(notice ? { notice } : {}) };
}

export const groupNames = (editor: GroupEditor): string[] => names(editor);
export const currentGroup = (editor: GroupEditor): string | null => names(editor)[editor.index] ?? null;

function memberIds(editor: GroupEditor, name: string): Set<string> {
  try { return new Set(parseGroups(editor.groups, editor.accounts)[name] ?? []); } catch { return new Set(); }
}

function accountMember(editor: GroupEditor, name: string, account: StoredAccount): boolean {
  return memberIds(editor, name).has(account.id);
}

function validate(editor: GroupEditor, groups: AccountGroups): string | undefined {
  try { parseGroups(groups, editor.accounts); return undefined; } catch (error) { return (error as Error).message; }
}

function saveEditor(editor: GroupEditor, groups: AccountGroups, notice: string, focus: string | null = currentGroup(editor), session?: GroupSave['session']): { editor: GroupEditor; save?: GroupSave } {
  const stored: AccountGroups = Object.fromEntries(Object.entries(groups).map(([name, members]) => [name, [...members]]));
  const error = validate(editor, stored);
  if (error) return { editor: { ...editor, error } };
  const next = openGroupEditor({ accounts: editor.accounts, groups: stored }, focus, notice);
  return { editor: next, save: { groups: stored, focus, notice, ...(session ? { session } : {}) } };
}

export function groupEditorKey(editor: GroupEditor, key: string): { editor: GroupEditor; save?: GroupSave; close?: boolean } {
  if (editor.phase === 'delete') {
    const name = currentGroup(editor);
    if ((key === 'y' || key === '\r') && name) {
      const groups: AccountGroups = Object.fromEntries(Object.entries(editor.groups).filter(([group]) => group !== name).map(([group, members]) => [group, [...members]]));
      const list = Object.keys(groups); const focus = list[Math.min(editor.index, list.length - 1)] ?? null;
      return saveEditor(editor, groups, `Deleted group ${name}`, focus, { type: 'delete', name });
    }
    if (key === 'n' || key === '\x1b') return { editor: { ...editor, phase: 'list', notice: 'Delete cancelled', error: undefined } };
    return { editor };
  }

  if (editor.phase === 'name') {
    if (key === '\x1b') return { editor: { ...editor, phase: 'list', draft: undefined, rename: undefined, error: undefined, notice: 'Edit cancelled — nothing saved' } };
    if (BACKSPACE.has(key)) return { editor: { ...editor, draft: (editor.draft ?? '').slice(0, -1), error: undefined } };
    if (key !== '\r') {
      return printable(key) ? { editor: { ...editor, draft: `${editor.draft ?? ''}${key}`, error: undefined } } : { editor };
    }
    const name = (editor.draft ?? '').trim();
    const old = editor.rename;
    if (old && name !== old && Object.hasOwn(editor.groups, name)) return { editor: { ...editor, error: `Group ${name} already exists` } };
    const groups: AccountGroups = Object.create(null);
    for (const [group, members] of Object.entries(editor.groups)) groups[group === old ? name : group] = [...members];
    if (!old) {
      const first = editor.accounts.find((account) => account.provider === 'claude');
      if (!first) return { editor: { ...editor, error: 'Add a Claude account before creating a group' } };
      groups[name] = [first.label];
    }
    const error = !name ? 'Group name is required' : validate(editor, groups);
    if (error) return { editor: { ...editor, error } };
    return saveEditor(editor, groups, `${old ? 'Renamed' : 'Created'} group ${name}`, name, old && old !== name ? { type: 'rename', from: old, to: name } : undefined);
  }

  if (editor.phase === 'members') {
    if (key === '\x1b') return { editor: { ...editor, phase: 'list', error: undefined } };
    const accounts = allAccounts(editor);
    if (UP.has(key)) return { editor: { ...editor, accountIndex: Math.max(0, editor.accountIndex - 1), error: undefined } };
    if (DOWN.has(key)) return { editor: { ...editor, accountIndex: Math.min(Math.max(0, accounts.length - 1), editor.accountIndex + 1), error: undefined } };
    if (key === ' ') {
      const name = currentGroup(editor); const account = accounts[editor.accountIndex];
      if (!name || !account) return { editor };
      if (account.provider !== 'claude') return { editor: { ...editor, error: `Cannot add Codex account ${account.label} to a Claude group` } };
      const groups: AccountGroups = Object.fromEntries(Object.entries(editor.groups).map(([group, members]) => [group, [...members]]));
      const list = groups[name] ?? []; const existing = accountMember(editor, name, account);
      if (existing && list.length <= 1) return { editor: { ...editor, error: `Group ${name} must keep at least one account; delete the group instead` } };
      const removing = existing;
      groups[name] = removing ? list.filter((ref) => ref !== account.id && ref !== account.label) : [...list, account.label];
      const previous = editor.pendingRemovals ?? [];
      const pendingRemovals = removing
        ? [...previous.filter((entry) => !(entry.group === name && entry.accountId === account.id)), { group: name, accountId: account.id }]
        : previous.filter((entry) => !(entry.group === name && entry.accountId === account.id));
      return { editor: { ...editor, groups, error: undefined, pendingRemovals: pendingRemovals.length ? pendingRemovals : undefined } };
    }
    if (key === '\r') {
      const name = currentGroup(editor); if (!name) return { editor: { ...editor, phase: 'list' } };
      return saveEditor(editor, editor.groups, `Updated group ${name}`, name, editor.pendingRemovals?.length ? { type: 'remove-members', removals: editor.pendingRemovals } : undefined);
    }
    return { editor };
  }

  // List view.
  if (key === '\x1b' || key === 'q') return { editor, close: true };
  const list = names(editor);
  if (UP.has(key)) return { editor: { ...editor, index: Math.max(0, editor.index - 1), error: undefined, notice: undefined } };
  if (DOWN.has(key)) return { editor: { ...editor, index: Math.min(Math.max(0, list.length - 1), editor.index + 1), error: undefined, notice: undefined } };
  if (key === 'a') return { editor: { ...editor, phase: 'name', draft: '', rename: undefined, error: undefined, notice: undefined } };
  if ((key === 'e' || key === '\r') && list[editor.index]) return { editor: { ...editor, phase: 'name', draft: list[editor.index]!, rename: list[editor.index], error: undefined, notice: undefined } };
  if (key === 'd' && list[editor.index]) return { editor: { ...editor, phase: 'delete', error: undefined, notice: undefined } };
  if ((key === 'm' || key === ' ') && list[editor.index]) return { editor: { ...editor, phase: 'members', accountIndex: editor.accountIndex < editor.accounts.length ? editor.accountIndex : Math.max(0, editor.accounts.findIndex((account) => account.provider === 'claude')), error: undefined, notice: undefined } };
  return { editor };
}

// Human-readable editor, kept independent of the dashboard so narrow and wide
// layouts can use the same key behavior.
const ESC = '\x1b['; const RESET = `${ESC}0m`;
const color = (code: number, text: string): string => `${ESC}${code}m${text}${RESET}`;
export function groupEditorLines(editor: GroupEditor, width: number): string[] {
  const current = currentGroup(editor); const title = editor.phase === 'members' ? ` Group members — ${current ?? ''} ` : editor.phase === 'name' ? ` ${editor.rename ? 'Rename' : 'New'} group ` : ` Claude groups (${names(editor).length}) `;
  const out = [color(36, `┌─${title}${'─'.repeat(Math.max(0, width - title.length - 3))}┐`)];
  if (editor.phase === 'name') out.push(`  name ${editor.draft ?? ''}${color(7, ' ')}`);
  else if (editor.phase === 'members') {
    const ids = current ? memberIds(editor, current) : new Set<string>();
    for (const [i, account] of allAccounts(editor).entries()) {
      const selected = i === editor.accountIndex; const member = account.provider === 'claude' && ids.has(account.id);
      const mark = selected ? color(36, '>') : ' ';
      const suffix = account.provider === 'codex' ? color(31, ' (Codex cannot join Claude groups)') : ` [${member ? 'x' : ' '}]`;
      out.push(`${mark} ${account.label}${suffix}`);
    }
    if (!allAccounts(editor).length) out.push(color(90, '  No accounts')); 
  } else {
    if (!names(editor).length) out.push(color(90, '  No groups — a to create one'));
    names(editor).forEach((name, i) => out.push(`${i === editor.index ? color(36, '>') : ' '} ${name}  [${editor.groups[name]!.length} accounts]`));
  }
  if (editor.error) out.push(color(31, `  Not saved: ${editor.error}`));
  else if (editor.notice) out.push(color(32, `  ${editor.notice}`));
  out.push(color(36, `└${'─'.repeat(Math.max(0, width - 2))}┘`));
  return out.map((line) => fit(line, width));
}

export function groupEditorFooter(editor: GroupEditor): string {
  if (editor.phase === 'delete') return ` DELETE group ${currentGroup(editor) ?? ''}? y/Enter confirm   n/Esc cancel`;
  if (editor.phase === 'name') return ' GROUP NAME: type  Backspace erase   Enter save   Esc cancel';
  if (editor.phase === 'members') return ' MEMBERS: ↑↓ select   Space toggle   Enter done   Esc cancel';
  return ' GROUPS: ↑↓ select   a add   e/Enter rename   m/Space members   d delete   Esc close';
}
