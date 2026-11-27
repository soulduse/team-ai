import { execFile, spawn } from 'node:child_process';
import type { OAuthCredential, ProviderId } from './types.js';

// Following another machine's logins (2026-11-26).
//
// A Claude refresh token is spent by the refresh that replaces it, so two
// machines holding one login keep signing each other out: whichever refreshes
// first wins and the other gets 400 "re-login needed" (copying credentials.json
// to a second machine eventually signs every shared account out there). A follower
// therefore never refreshes an account its leader also holds. It reads the
// leader's credentials instead and adopts any token that expires later than
// its own (AccountPool.adoptCredentials), so a login done once on the leader
// reaches the follower within one pull. Accounts the leader does not hold are
// refreshed locally as before.
export interface SyncConfig {
  role: 'follower';
  // ssh destination of the leader (an ~/.ssh/config alias is fine).
  peer: string;
  providers?: ProviderId[];
  intervalMs?: number;
  // The leader's credentials file, as the remote shell sees it.
  path?: string;
  // Failover: refresh here anyway once the leader has been unreachable this
  // long and a token is about to lapse; the newer token is pushed back to the
  // leader when it returns. 0 disables failover.
  failoverAfterMs?: number;
  // node on the leader, for the push-back (non-login ssh has a short PATH).
  node?: string;
}

export type Puller = (() => Promise<Record<string, OAuthCredential>>) & {
  // When the current run of failed reads began; null while the leader answers.
  downSince?: () => number | null;
};
export type OAuthRecords = Record<string, OAuthCredential>;
export type Pusher = (records: Record<string, OAuthCredential>) => Promise<number>;
export type Runner = (args: string[], timeoutMs: number) => Promise<string>;

export const DEFAULT_SYNC_INTERVAL_MS = 2 * 60_000;
// Failover is opt-in (sync.failoverAfterMs): a leader that is awake but cut off
// from us would otherwise race us for one refresh token.
export const DEFAULT_FAILOVER_AFTER_MS = 0;
const DEFAULT_PATH = '~/.config/teamai/credentials.json';
const PULL_TIMEOUT_MS = 20_000;
// Callers that land together (a sweep and a request) share one read.
const PULL_REUSE_MS = 10_000;

export function followedProviders(sync: SyncConfig | undefined): ProviderId[] {
  if (sync?.role !== 'follower' || !sync.peer) return [];
  return sync.providers?.length ? sync.providers : ['claude'];
}

// Only well-formed records of followed providers cross over.
export function pickFollowed(raw: unknown, providers: ProviderId[]): Record<string, OAuthCredential> {
  const out: Record<string, OAuthCredential> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!providers.some((p) => id.startsWith(`${p}:`))) continue;
    const c = value as Partial<OAuthCredential> | null;
    if (!c || typeof c.accessToken !== 'string' || typeof c.expiresAt !== 'number') continue;
    out[id] = c as OAuthCredential;
  }
  return out;
}

const runSsh: Runner = (args, timeoutMs) => new Promise((resolve, reject) => {
  execFile('ssh', args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

// An unreachable leader is reported the way an unreachable token endpoint is,
// so the account is benched and retried rather than shown as needing a re-login.
export function leaderUnreachable(peer: string, cause: unknown): Error {
  return Object.assign(new Error(`leader ${peer} unreachable (${(cause as Error)?.message ?? String(cause)})`), { name: 'TimeoutError' });
}

// Only a failure to reach the leader at all counts toward failover: ssh exits
// 255 on a connection or authentication failure, and a timeout kills it. A
// leader that answered but whose file could not be read or parsed is up — it
// is still refreshing its tokens, so refreshing here would race it.
export function connectionFailed(error: unknown): boolean {
  const e = error as { code?: unknown; killed?: boolean; signal?: unknown } | null;
  return e?.code === 255 || e?.killed === true || (e?.signal ?? null) !== null;
}

export function sshPuller(sync: SyncConfig, run: Runner = runSsh, now: () => number = Date.now): Puller {
  const providers = followedProviders(sync);
  const path = sync.path || DEFAULT_PATH;
  let last: { at: number; read: Promise<Record<string, OAuthCredential>> } | null = null;
  let downSince: number | null = null;
  const pull: Puller = () => {
    if (last && now() - last.at < PULL_REUSE_MS) return last.read;
    const read = run(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', sync.peer, `cat ${path}`], PULL_TIMEOUT_MS)
      .then((text) => { const picked = pickFollowed(JSON.parse(text), providers); downSince = null; return picked; })
      .catch((error) => { if (last?.read === read) last = null; if (connectionFailed(error)) downSince ??= now(); else downSince = null; /* it answered: it is up */ throw leaderUnreachable(sync.peer, error); });
    last = { at: now(), read };
    return read;
  };
  pull.downSince = () => downSince;
  return pull;
}

// Runs on the leader: merge the pushed records into its credentials file, each
// only when it expires later than the one there, written the way storage.ts
// writes it (temp file, 0600, rename). The leader's server then adopts them on
// its next save, exactly as it adopts a re-login. Prints how many it took.
const MERGE_SCRIPT = `
const fs = require('fs'), os = require('os');
const given = process.argv[1];
const file = given.startsWith('~/') ? os.homedir() + given.slice(1) : given;
let input = '';
process.stdin.on('data', (d) => { input += d; }).on('end', () => {
  const incoming = JSON.parse(input);
  let current = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let taken = 0;
  for (const [id, c] of Object.entries(incoming)) {
    const held = current[id];
    if (held && typeof held.expiresAt === 'number' && held.expiresAt >= c.expiresAt) continue;
    current[id] = c; taken++;
  }
  if (taken) {
    const temp = file + '.' + process.pid + '.push.tmp';
    fs.writeFileSync(temp, JSON.stringify(current, null, 2) + '\\n', { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  process.stdout.write(String(taken));
});
`;

export type InputRunner = (args: string[], input: string, timeoutMs: number) => Promise<string>;

const runSshWithInput: InputRunner = (args, input, timeoutMs) => new Promise((resolve, reject) => {
  const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('push timed out'), { name: 'TimeoutError' })); }, timeoutMs);
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`ssh exit ${code}: ${err.trim().slice(-200)}`)); });
  child.stdin.on('error', () => { /* the child exited first; close reports why */ });
  child.stdin.end(input);
});

export function sshPusher(sync: SyncConfig, run: InputRunner = runSshWithInput): Pusher {
  const path = sync.path || DEFAULT_PATH;
  return async (records) => {
    if (!Object.keys(records).length) return 0;
    const out = await run(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', sync.peer, sync.node || 'node', '-e', shellQuote(MERGE_SCRIPT), shellQuote(path)], JSON.stringify(records), PULL_TIMEOUT_MS);
    return Number.parseInt(out.trim(), 10) || 0;
  };
}

// ssh joins the remote argv into one shell line, so each argument is quoted.
export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
