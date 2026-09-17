import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { OAuthCredential, PersistedState, ProviderId, StoredAccount, TeamAIConfig } from './types.js';

export function dataDir(): string {
  return process.env.TEAMAI_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'teamai');
}
export const paths = () => ({ config: join(dataDir(), 'config.json'), credentials: join(dataDir(), 'credentials.json'), state: join(dataDir(), 'state.json'), server: join(dataDir(), 'server.json') });

export function defaultConfig(): TeamAIConfig {
  return { version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, controlPort: 3556, clientToken: `tai-${randomBytes(24).toString('base64url')}` }, switchThreshold: 0.98, warmupIntervalMs: 5 * 60_000, maxConcurrentPerAccount: 3, accounts: [] };
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

export async function upsertAccount(provider: ProviderId, label: string, credential: OAuthCredential): Promise<StoredAccount> {
  const config = await loadConfig();
  const credentials = await loadCredentials();
  const existing = config.accounts.find((a) => a.provider === provider && a.id === credential.accountId);
  const credentialId = existing?.credentialId || `${provider}:${credential.accountId}`;
  const account: StoredAccount = existing || { id: credential.accountId, provider, label, enabled: true, priority: null, credentialId, createdAt: new Date().toISOString() };
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
