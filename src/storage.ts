import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { claudeOrganization, codexUserId } from './auth.js';
import type { OAuthCredential, PersistedState, ProviderId, StoredAccount, TeamAIConfig } from './types.js';

export function dataDir(): string {
  return process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai');
}
export const paths = () => ({ config: join(dataDir(), 'config.json'), credentials: join(dataDir(), 'credentials.json'), state: join(dataDir(), 'state.json'), server: join(dataDir(), 'server.json') });

export function defaultConfig(): TeamAIConfig {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, controlPort: 3556, clientToken: `tai-${randomBytes(24).toString('base64url')}` }, switchThreshold: 0.98, warmupIntervalMs: 5 * 60_000, maxConcurrentPerAccount: 16, fableReserveThreshold: 0.8, accounts: [] };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}

// One temp file per write, not per process: a save that outlives its timeout
// can still be in flight when the next one starts, and sharing a temp name let
// the two interleave into one file.
let tempSeq = 0;
// commit, when given, is asked right before the rename and can veto it; the
// temp file is removed and false returned.
async function atomicWrite(path: string, value: unknown, commit?: () => Promise<boolean>): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${++tempSeq}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (commit && !await commit()) return false;
    await rename(temp, path);
    return true;
  } finally { await rm(temp, { force: true }); }
}

export async function loadConfig(): Promise<TeamAIConfig> { return readJson(paths().config, defaultConfig()); }
export async function saveConfig(config: TeamAIConfig): Promise<void> { await atomicWrite(paths().config, config); }
export async function loadCredentials(): Promise<Record<string, OAuthCredential>> { return readJson(paths().credentials, {}); }
export async function saveCredentials(value: Record<string, OAuthCredential>): Promise<void> { await atomicWrite(paths().credentials, value); }
// The file exactly as stored, for a writer that must not overwrite what another
// process (a re-login in the TUI) wrote after it last looked.
export async function readCredentialsText(): Promise<string> {
  try { return await readFile(paths().credentials, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
// Write only if the file still reads as expected; false means it changed since
// and nothing was written. The check sits after the temp write, so a save
// delayed for minutes is judged against the file as it is when it lands.
export async function saveCredentialsIfUnchanged(value: Record<string, OAuthCredential>, expected: string, current: () => boolean = () => true): Promise<boolean> {
  return atomicWrite(paths().credentials, value, async () => current() && await readCredentialsText() === expected);
}
export async function loadState(): Promise<PersistedState> { return readJson(paths().state, { version: 1, accounts: {}, events: [] }); }
export async function saveState(value: PersistedState, commit?: () => Promise<boolean>): Promise<boolean> { return atomicWrite(paths().state, value, commit); }

// The key a stored account is known by: the account id, plus the user for a
// Codex workspace that several members share, or the organization for a Claude
// person who holds more than one subscription.
export function accountKey(credential: OAuthCredential): string {
  if (credential.userId) return `${credential.accountId}:${credential.userId}`;
  return credential.organizationId ? `${credential.accountId}:${credential.organizationId}` : credential.accountId;
}

// Codex accounts stored before the user joined the key are keyed by the
// workspace alone. Such a record is adopted only when it holds the same user;
// another member of that workspace gets a row of their own instead of
// overwriting it.
async function legacyAccount(config: TeamAIConfig, credentials: Record<string, OAuthCredential>, provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount | undefined> {
  if (credential.organizationId) return legacyClaudeAccount(config, credentials, provider, credential);
  if (!credential.userId) return undefined;
  return config.accounts.find((a) => {
    if (a.provider !== provider || a.id !== credential.accountId) return false;
    // The held token's user decides when it has one; the label (an email) is
    // only a fallback, since two members without an email claim share a label.
    const held = credentials[a.credentialId]; const heldUser = held ? codexUserId(held.accessToken) : null;
    return heldUser ? heldUser === credential.userId : a.label === label;
  });
}

// Claude accounts stored before the organization joined the key are keyed by
// the person alone. Such a record is adopted only when its token belongs to the
// same organization. A Claude token is opaque, so that takes a profile call;
// when the held token cannot answer, the login gets a row of its own — a
// duplicate can be disabled, an overwritten subscription cannot be recovered.
async function legacyClaudeAccount(config: TeamAIConfig, credentials: Record<string, OAuthCredential>, provider: ProviderId, credential: OAuthCredential): Promise<StoredAccount | undefined> {
  for (const a of config.accounts) {
    if (a.provider !== provider || a.id !== credential.accountId) continue;
    const held = credentials[a.credentialId]; if (!held) continue;
    const heldOrganization = held.organizationId ?? await claudeOrganization(held.accessToken);
    if (heldOrganization === credential.organizationId) return a;
  }
  return undefined;
}

export async function upsertAccount(provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount> {
  const config = await loadConfig();
  const credentials = await loadCredentials();
  const key = accountKey(credential);
  const existing = config.accounts.find((a) => a.provider === provider && a.id === key) || await legacyAccount(config, credentials, provider, label, credential);
  const credentialId = existing?.credentialId || `${provider}:${key}`;
  const account: StoredAccount = existing || { id: key, provider, label, enabled: true, priority: null, credentialId, createdAt: new Date().toISOString() };
  // A migrated record keeps its credentialId, so its saved usage history stays attached.
  account.id = key;
  account.label = label || account.label;
  if (!existing) config.accounts.push(account);
  credentials[credentialId] = credential;
  await saveCredentials(credentials);
  await saveConfig(config);
  return account;
}

export async function removeAccount(credentialId: string): Promise<boolean> {
  const config = await loadConfig(); const credentials = await loadCredentials(); const before = config.accounts.length;
  config.accounts = config.accounts.filter((account) => account.credentialId !== credentialId); delete credentials[credentialId];
  if (config.accounts.length === before) return false;
  await Promise.all([saveConfig(config), saveCredentials(credentials)]); return true;
}
