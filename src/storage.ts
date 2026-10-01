import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { codexUserId } from './auth.js';
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

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function loadConfig(): Promise<TeamAIConfig> { return readJson(paths().config, defaultConfig()); }
export async function saveConfig(config: TeamAIConfig): Promise<void> { await atomicWrite(paths().config, config); }
export async function loadCredentials(): Promise<Record<string, OAuthCredential>> { return readJson(paths().credentials, {}); }
export async function saveCredentials(value: Record<string, OAuthCredential>): Promise<void> { await atomicWrite(paths().credentials, value); }
export async function loadState(): Promise<PersistedState> { return readJson(paths().state, { version: 1, accounts: {}, events: [] }); }
export async function saveState(value: PersistedState): Promise<void> { await atomicWrite(paths().state, value); }

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
  const config = await loadConfig();
  const credentials = await loadCredentials();
  const key = accountKey(credential);
  const existing = config.accounts.find((a) => a.provider === provider && a.id === key) || legacyAccount(config, credentials, provider, label, credential);
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
