import { randomBytes, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { codexUserId } from './auth.js';
import type { OAuthCredential, PersistedState, ProviderId, StoredAccount, StoredSessionBinding, StoredSessionBindings, TeamAIConfig } from './types.js';

export function dataDir(): string {
  return process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai');
}
export const paths = () => ({ config: join(dataDir(), 'config.json'), credentials: join(dataDir(), 'credentials.json'), state: join(dataDir(), 'state.json'), server: join(dataDir(), 'server.json'), sessions: join(dataDir(), 'sessions.json') });

export function defaultConfig(): TeamAIConfig {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, controlPort: 3556, clientToken: `tai-${randomBytes(24).toString('base64url')}` }, switchThreshold: 0.98, warmup: { enabled: true, claude: true, codex: true }, maxConcurrentPerAccount: 16, codexCapacityEnabled: true, codexCapacityRetryMs: 500, codexCapacityPreambleHoldMs: 500, codexCapacityRotation: false, accounts: [] };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

// Each write gets a temporary file of its own: two saves of one file used to
// share `<file>.<pid>.tmp`, so the second overwrote the first's half-written
// copy and the first rename then failed or moved the wrong bytes into place.
async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

// A lock older than this is from a process that died holding it: every hold is
// one read, one change and one write.
const LOCK_STALE_MS = 10_000;
const LOCK_POLL_MS = 10;

async function staleLock(lock: string): Promise<boolean> {
  try {
    const [text, info] = await Promise.all([readFile(lock, 'utf8'), stat(lock)]);
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const pid = Number(text);
    // Still being written by its owner: only its age can make it stale.
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

// `<file>.lock`, created exclusively, is held across processes (the server's
// saves, the dashboard, a CLI command) for the whole read/change/write.
async function withFileLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try { const handle = await open(lock, 'wx', 0o600); try { await handle.writeFile(String(process.pid)); } finally { await handle.close(); } break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await staleLock(lock)) await rm(lock, { force: true }); else await delay(LOCK_POLL_MS);
    }
  }
  try { return await run(); } finally { await rm(lock, { force: true }); }
}

// Changes to one file run one at a time: queued in this process, and behind the
// lock file between processes. Without it a server save that read the file
// before a login or a delete wrote it back as it was, losing the login or
// bringing the deleted account back.
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(path: string, run: () => Promise<T>): Promise<T> {
  const locked = (): Promise<T> => withFileLock(path, run);
  const next = (queues.get(path) ?? Promise.resolve()).then(locked, locked);
  const tail = next.then(() => {}, () => {}); queues.set(path, tail);
  return next.finally(() => { if (queues.get(path) === tail) queues.delete(path); });
}

export function updateCredentials(update: (credentials: Record<string, OAuthCredential>) => void | Promise<void>): Promise<void> {
  const path = paths().credentials;
  return serialized(path, async () => { const current = await readJson<Record<string, OAuthCredential>>(path, {}); await update(current); await atomicWrite(path, current); });
}

// config.json read, changed and written under the same lock. A change that
// returns false writes nothing; the result says whether it was written.
export function updateConfig(change: (config: TeamAIConfig) => void | false | Promise<void | false>): Promise<boolean> {
  const path = paths().config;
  return serialized(path, async () => { const config = await readJson(path, defaultConfig()); if (await change(config) === false) return false; await atomicWrite(path, config); return true; });
}

export async function loadConfig(): Promise<TeamAIConfig> { return readJson(paths().config, defaultConfig()); }
export async function saveConfig(config: TeamAIConfig): Promise<void> { const path = paths().config; await serialized(path, () => atomicWrite(path, config)); }
export async function loadCredentials(): Promise<Record<string, OAuthCredential>> { return readJson(paths().credentials, {}); }
export async function saveCredentials(value: Record<string, OAuthCredential>): Promise<void> { const path = paths().credentials; await serialized(path, () => atomicWrite(path, value)); }
export async function loadState(): Promise<PersistedState> { return readJson(paths().state, { version: 1, accounts: {}, events: [] }); }
export async function saveState(value: PersistedState): Promise<void> { await atomicWrite(paths().state, value); }

type SessionLedgerEntry = 'pending' | 'bound' | { state: 'pending' | 'bound'; group: string };
type SessionLedger = Record<string, SessionLedgerEntry>;
const ledgerState = (entry: SessionLedgerEntry): 'pending' | 'bound' => typeof entry === 'string' ? entry : entry.state;

function ledgerPathFor(sessionsPath: string): string {
  return join(dirname(sessionsPath), '.sessions-ledger.json');
}

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function validateLedger(raw: unknown): SessionLedger {
  // Older ledgers list bound IDs only; they never authorize a new binding.
  if (Array.isArray(raw)) {
    if (!raw.every((id) => typeof id === 'string' && id.trim() && !['__proto__', 'constructor', 'prototype'].includes(id))) throw new Error('Invalid session ledger');
    return Object.assign(Object.create(null), Object.fromEntries(raw.map((id) => [id, 'bound'])));
  }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid session ledger');
  const ledger: SessionLedger = Object.create(null);
  for (const [id, state] of Object.entries(raw)) {
    const grouped = state && typeof state === 'object' && !Array.isArray(state)
      && ['pending', 'bound'].includes(state.state) && typeof state.group === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(state.group);
    if (!id.trim() || ['__proto__', 'constructor', 'prototype'].includes(id) || (state !== 'pending' && state !== 'bound' && !grouped)) throw new Error('Invalid session ledger entry');
    ledger[id] = state as SessionLedgerEntry;
  }
  return ledger;
}

// All three files are read under sessions.json.lock. Partial creation or a
// partial commit is an error; it must never restore initial account selection.
async function readSessionStore(): Promise<{ bindings: StoredSessionBindings; ledger: SessionLedger; fresh: boolean }> {
  const path = paths().sessions;
  const [marker, text, ledgerText] = await Promise.all([
    readOptional(join(dirname(path), '.sessions-created')), readOptional(path), readOptional(ledgerPathFor(path)),
  ]);
  if (marker === null && text === null && ledgerText === null) return { bindings: Object.create(null), ledger: Object.create(null), fresh: true };
  if (marker !== '1\n' || text === null || ledgerText === null) throw new Error('Session storage is missing or incomplete');
  const bindings = validateSessionBindings(JSON.parse(text));
  const ledger = validateLedger(JSON.parse(ledgerText));
  for (const [id, state] of Object.entries(ledger)) {
    if ((ledgerState(state) === 'bound') !== Object.hasOwn(bindings, id)) throw new Error('Session ledger and bindings disagree');
  }
  for (const id of Object.keys(bindings)) {
    if (!ledger[id] || ledgerState(ledger[id]!) !== 'bound') throw new Error('Session binding has no ledger record');
    const entry = ledger[id]!;
    if (bindings[id]!.group !== (typeof entry === 'string' ? undefined : entry.group)) throw new Error('Session group and ledger disagree');
  }
  return { bindings, ledger, fresh: false };
}

async function initializeSessionStore(): Promise<void> {
  // Write the marker first: interrupted creation remains closed on restart.
  await writeFile(join(dirname(paths().sessions), '.sessions-created'), '1\n', { mode: 0o600, flag: 'wx' });
  await atomicWrite(ledgerPathFor(paths().sessions), {});
  await atomicWrite(paths().sessions, {});
}

// Only the authenticated relay control handler calls this for client launches.
// Callers cannot register a chosen conversation ID.
export function issueClaudeSession(group?: string): Promise<string> {
  const path = paths().sessions;
  return serialized(path, async () => {
    const { ledger, fresh } = await readSessionStore();
    if (fresh) await initializeSessionStore();
    let id: string;
    do { id = randomUUID(); } while (Object.hasOwn(ledger, id));
    ledger[id] = group === undefined ? 'pending' : { state: 'pending', group };
    await atomicWrite(ledgerPathFor(path), ledger);
    return id;
  });
}

// The longest conversation ID an administrator can adopt. Claude Code's own IDs
// are 36-character UUIDs.
export const ADOPT_SESSION_ID_MAX = 256;

// A conversation ID the relay can see again exactly as stored: dispatch trims
// the header and splits it on commas, and refuses prototype property names.
// Visible ASCII only, so no whitespace or control characters either.
export function adoptableSessionId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (!id || id.length > ADOPT_SESSION_ID_MAX || !/^[\x21-\x7e]+$/.test(id) || id.includes(',')) return null;
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') return null;
  return id;
}

export type AdoptOutcome = 'adopted' | 'already_bound' | 'conflict' | 'pending';

// Records an existing conversation, named by an administrator, as first bound
// to one account: the conversation started before this relay issued IDs, so
// it has no registration. The binding and its ledger record are written under
// the same lock as registration and dispatch, and every refusal writes
// nothing. pick() runs inside that lock and returns the binding to record (it
// throws when the account cannot take one). A conversation that is already
// bound keeps its binding: the same account again is a no-op, any other is a
// conflict. A registration still pending belongs to a relay-started session.
export function adoptClaudeSession(sessionId: string, pick: () => StoredSessionBinding): Promise<AdoptOutcome> {
  const path = paths().sessions;
  return serialized(path, async () => {
    const { bindings, ledger, fresh } = await readSessionStore();
    const binding = pick();
    if (binding.sessionId !== sessionId || binding.provider !== 'claude') throw new Error('Adopted binding does not match the request');
    if (ledger[sessionId] && ledgerState(ledger[sessionId]!) === 'pending') return 'pending';
    const existing = bindings[sessionId];
    if (existing) {
      const same = existing.provider === 'claude' && existing.accountId === binding.accountId
        && existing.credentialId === binding.credentialId && existing.actualAccountId === binding.actualAccountId;
      return same ? 'already_bound' : 'conflict';
    }
    bindings[sessionId] = binding;
    const validated = validateSessionBindings(bindings);
    if (fresh) await initializeSessionStore();
    ledger[sessionId] = 'bound';
    // The ledger first, as for a dispatch binding: an interrupted write leaves
    // a ledger record with no binding, which fails closed on the next read.
    await atomicWrite(ledgerPathFor(path), ledger);
    await atomicWrite(path, validated);
    return 'adopted';
  });
}

export function validateSessionBindings(raw: unknown): StoredSessionBindings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Corrupt session bindings: root must be an object');
  }
  const result: StoredSessionBindings = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error(`Corrupt session binding: invalid prototype property name "${key}"`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Corrupt session binding for "${key}": entry must be an object`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.sessionId !== 'string' || !entry.sessionId.trim()) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid sessionId`);
    }
    if (key !== entry.sessionId) {
      throw new Error(`Corrupt session binding for "${key}": key does not match entry.sessionId "${entry.sessionId}"`);
    }
    if (entry.provider !== 'claude' && entry.provider !== 'codex') {
      throw new Error(`Corrupt session binding for "${key}": invalid provider "${String(entry.provider)}"`);
    }
    if (typeof entry.accountId !== 'string' || !entry.accountId.trim()) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid accountId`);
    }
    if (typeof entry.credentialId !== 'string' || !entry.credentialId.trim()) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid credentialId`);
    }
    if (typeof entry.actualAccountId !== 'string' || !entry.actualAccountId.trim()) {
      throw new Error(`Corrupt session binding for "${key}": missing or invalid actualAccountId`);
    }
    if (typeof entry.boundAt !== 'number' || !Number.isFinite(entry.boundAt)) {
      throw new Error(`Corrupt session binding for "${key}": invalid boundAt timestamp`);
    }
    if (entry.group !== undefined && (typeof entry.group !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(entry.group))) throw new Error('Corrupt session group');
    result[key] = {
      ...(entry.group === undefined ? {} : { group: entry.group as string }),
      sessionId: entry.sessionId,
      provider: entry.provider,
      accountId: entry.accountId,
      credentialId: entry.credentialId.trim(),
      actualAccountId: entry.actualAccountId.trim(),
      boundAt: entry.boundAt,
    };
  }
  return result;
}

export function loadSessions(): Promise<StoredSessionBindings> {
  return serialized(paths().sessions, async () => (await readSessionStore()).bindings);
}

export function updateSessions(change: (bindings: StoredSessionBindings, pending: ReadonlySet<string>, groups: ReadonlyMap<string, string>) => void | false | Promise<void | false>): Promise<boolean> {
  const path = paths().sessions;
  return serialized(path, async () => {
    const { bindings, ledger, fresh } = await readSessionStore();
    const pending = new Set(Object.keys(ledger).filter((id) => ledgerState(ledger[id]!) === 'pending'));
    const groups = new Map(Object.entries(ledger).flatMap(([id, entry]) => typeof entry === 'string' ? [] : [[id, entry.group] as const]));
    if (await change(bindings, pending, groups) === false) return false;
    const validated = validateSessionBindings(bindings);
    for (const id of Object.keys(validated)) {
      if (!Object.hasOwn(ledger, id)) throw new Error('Cannot bind an unregistered session');
    }
    if (fresh) throw new Error('Session registration required before binding');
    for (const id of Object.keys(validated)) {
      const group = groups.get(id);
      if (validated[id]!.group !== group) throw new Error('Cannot change a registered session group');
      ledger[id] = group === undefined ? 'bound' : { state: 'bound', group };
    }
    // Consume registration before committing the binding. A crash between these
    // writes leaves a missing bound entry and refuses every subsequent request.
    await atomicWrite(ledgerPathFor(path), ledger);
    await atomicWrite(path, validated);
    return true;
  });
}

// Removing the last member of a group removes the group itself. Stored
// sessions must lose that scope as well, including registrations that have
// not made their first request yet; otherwise a later request would refer to
// a group that no longer exists. This is kept separate from updateSessions so
// normal session binding cannot change a group's identity.
export function clearSessionGroups(names: ReadonlySet<string>): Promise<boolean> {
  if (!names.size) return Promise.resolve(false);
  const path = paths().sessions;
  return serialized(path, async () => {
    const { bindings, ledger, fresh } = await readSessionStore();
    if (fresh) return false;
    let changed = false;
    for (const [id, binding] of Object.entries(bindings)) {
      if (binding.group !== undefined && names.has(binding.group)) {
        delete binding.group;
        changed = true;
      }
      const entry = ledger[id];
      if (entry && typeof entry === 'object' && names.has(entry.group)) {
        ledger[id] = entry.state;
        changed = true;
      }
    }
    for (const [id, entry] of Object.entries(ledger)) {
      if (typeof entry === 'object' && names.has(entry.group)) {
        ledger[id] = entry.state;
        changed = true;
      }
    }
    if (!changed) return false;
    const validated = validateSessionBindings(bindings);
    for (const id of Object.keys(validated)) {
      const entry = ledger[id];
      if (!entry || ledgerState(entry) !== 'bound') throw new Error('Session ledger and bindings disagree');
      if (validated[id]!.group !== (typeof entry === 'string' ? undefined : entry.group)) throw new Error('Session group and ledger disagree');
    }
    await atomicWrite(ledgerPathFor(path), ledger);
    await atomicWrite(path, validated);
    return true;
  });
}

// Rename a configured Claude group in every pending registration and bound
// session. The binding and ledger are rewritten under the same sessions lock so
// a request can never observe the old name in one file and the new name in the
// other. This is deliberately separate from updateSessions, which forbids
// changing a registered session's group during normal request binding.
export function renameSessionGroup(from: string, to: string): Promise<boolean> {
  if (from === to) return Promise.resolve(false);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(from) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(to) || ['__proto__', 'constructor', 'prototype'].includes(from) || ['__proto__', 'constructor', 'prototype'].includes(to)) throw new Error('Invalid session group name');
  const path = paths().sessions;
  return serialized(path, async () => {
    const { bindings, ledger, fresh } = await readSessionStore();
    if (fresh) return false;
    let changed = false;
    for (const binding of Object.values(bindings)) {
      if (binding.group === from) { binding.group = to; changed = true; }
    }
    for (const [id, entry] of Object.entries(ledger)) {
      if (typeof entry === 'object' && entry.group === from) { ledger[id] = { state: entry.state, group: to }; changed = true; }
    }
    if (!changed) return false;
    const validated = validateSessionBindings(bindings);
    for (const id of Object.keys(validated)) {
      const entry = ledger[id];
      if (!entry || ledgerState(entry) !== 'bound') throw new Error('Session ledger and bindings disagree');
      if (validated[id]!.group !== (typeof entry === 'string' ? undefined : entry.group)) throw new Error('Session group and ledger disagree');
    }
    await atomicWrite(ledgerPathFor(path), ledger);
    await atomicWrite(path, validated);
    return true;
  });
}

// The key a stored account is known by: the account id, plus the user for a
// Codex workspace that several members share.
export function accountKey(credential: OAuthCredential): string {
  return credential.userId ? `${credential.accountId}:${credential.userId}` : credential.accountId;
}

// Codex accounts stored before the user joined the key are keyed by the
// workspace alone. Such a record is adopted only when it holds the same user;
// another member of that workspace gets a row of their own instead of
// overwriting it.
function legacyAccount(config: TeamAIConfig, credentials: Record<string, OAuthCredential>, provider: ProviderId, label: string, credential: OAuthCredential): StoredAccount | undefined {
  if (!credential.userId) return undefined;
  return config.accounts.find((a) => {
    if (a.provider !== provider || a.id !== credential.accountId) return false;
    // The held token's user decides when it has one; the label (an email) is
    // only a fallback, since two members without an email claim share a label.
    const held = credentials[a.credentialId]; const heldUser = held ? codexUserId(held.accessToken) : null;
    return heldUser ? heldUser === credential.userId : a.label === label;
  });
}

export async function upsertAccount(provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount> {
  let saved!: StoredAccount;
  await updateConfig(async (config) => {
    const credentials = await loadCredentials();
    const key = accountKey(credential);
    const existing = config.accounts.find((a) => a.provider === provider && a.id === key) || legacyAccount(config, credentials, provider, label, credential);
    const credentialId = existing?.credentialId || `${provider}:${key}`;
    const account: StoredAccount = existing || { id: key, provider, label, enabled: true, priority: null, credentialId, createdAt: new Date().toISOString() };
    // A migrated record keeps its credentialId, so its saved usage history stays attached.
    account.id = key;
    account.label = label || account.label;
    if (!existing) config.accounts.push(account);
    await updateCredentials((current) => { current[credentialId] = credential; });
    saved = account;
  });
  return saved;
}

export async function removeAccount(credentialId: string): Promise<boolean> {
  let removedAccount: StoredAccount | undefined;
  const removedGroups = new Set<string>();
  const removed = await updateConfig((config) => {
    removedAccount = config.accounts.find((account) => account.credentialId === credentialId);
    if (!removedAccount) return false;
    const claudeIds = new Set(config.accounts.filter((account) => account.provider === 'claude').map((account) => account.id));
    config.accounts = config.accounts.filter((account) => account.credentialId !== credentialId);
    if (removedAccount.provider !== 'claude' || !config.groups || typeof config.groups !== 'object' || Array.isArray(config.groups)) return;
    const next: Record<string, string[]> = {};
    for (const [name, members] of Object.entries(config.groups)) {
      if (!Array.isArray(members)) { next[name] = members as string[]; continue; }
      const remaining = members.filter((ref) => {
        if (typeof ref !== 'string') return true;
        // parseGroups gives an exact id precedence over a label. Keep that
        // rule here so a removed label cannot accidentally remove another
        // account whose id happens to use the same text.
        return claudeIds.has(ref) ? ref !== removedAccount!.id : ref !== removedAccount!.label;
      });
      if (remaining.length) next[name] = remaining;
      else removedGroups.add(name);
    }
    config.groups = Object.keys(next).length ? next : undefined;
  });
  if (removed) {
    if (removedGroups.size) await clearSessionGroups(removedGroups);
    await updateCredentials((current) => { delete current[credentialId]; });
  }
  return removed;
}
