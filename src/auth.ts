import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import type { OAuthCredential, ProviderId } from './types.js';

function expand(path: string): string { return path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(path); }
function decodeJwt(token: string): Record<string, unknown> { try { const part = token.split('.')[1]; return part ? JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown> : {}; } catch { return {}; } }
function stringAt(value: unknown, key: string): string | null { return value && typeof value === 'object' && typeof (value as Record<string, unknown>)[key] === 'string' ? (value as Record<string, string>)[key]! : null; }

export async function importAuth(provider: ProviderId, from?: string): Promise<Array<{ label: string; credential: OAuthCredential }>> {
  const path = expand(from || (provider === 'claude' ? '~/.claude/.credentials.json' : join(process.env.CODEX_HOME || '~/.codex', 'auth.json')));
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (provider === 'claude') {
    if (Array.isArray(raw.accounts)) {
      const accounts = raw.accounts.flatMap((entry) => {
        const data = entry as Record<string, unknown>;
        if (typeof data.accessToken !== 'string' || typeof data.accountUuid !== 'string') return [];
        return [{ label: typeof data.name === 'string' ? data.name : data.accountUuid, credential: { accessToken: data.accessToken, refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null, accountId: data.accountUuid } }];
      });
      if (!accounts.length) throw new Error('No OAuth accounts found in TeamClaude config');
      return accounts;
    }
    const data = (raw.claudeAiOauth || raw) as Record<string, unknown>;
    if (typeof data.accessToken !== 'string') throw new Error('Claude accessToken is missing');
    const profile = await claudeProfile(data.accessToken);
    return [{ label: profile.label, credential: { accessToken: data.accessToken, refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : null, expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null, accountId: profile.id } }];
  }
  const tokens = (raw.tokens || raw) as Record<string, unknown>;
  if (typeof tokens.access_token !== 'string') throw new Error('Codex access_token is missing');
  const idClaims = decodeJwt(typeof tokens.id_token === 'string' ? tokens.id_token : tokens.access_token);
  const auth = idClaims['https://api.openai.com/auth'];
  const accountId = typeof tokens.account_id === 'string' ? tokens.account_id : stringAt(auth, 'chatgpt_account_id') || stringAt(auth, 'account_id');
  if (!accountId) throw new Error('Codex account_id is missing');
  const exp = decodeJwt(tokens.access_token).exp;
  return [{ label: stringAt(idClaims, 'email') || accountId, credential: { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null, expiresAt: typeof exp === 'number' ? exp * 1000 : null, accountId } }];
}

async function claudeProfile(accessToken: string): Promise<{ id: string; label: string }> {
  const response = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${accessToken}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Claude profile failed (${response.status})`);
  const value = await response.json() as { account?: { uuid?: string; email?: string } };
  if (!value.account?.uuid) throw new Error('Claude account UUID is missing');
  return { id: value.account.uuid, label: value.account.email || value.account.uuid };
}

export async function loginClaude(): Promise<{ label: string; credential: OAuthCredential }> {
  const verifier = randomBytes(32).toString('base64url'); const challenge = createHash('sha256').update(verifier).digest('base64url'); const state = randomBytes(32).toString('base64url');
  let resolveCode!: (code: string) => void; let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((req, res) => { const url = new URL(req.url || '/', 'http://localhost'); if (url.searchParams.get('state') !== state || !url.searchParams.get('code')) { res.writeHead(400).end('Invalid callback'); rejectCode(new Error('Invalid OAuth callback')); return; } res.end('TeamAI login complete. You may close this tab.'); resolveCode(url.searchParams.get('code')!); });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Failed to bind OAuth callback');
  const redirect = `http://localhost:${address.port}/callback`;
  const url = new URL('https://claude.ai/oauth/authorize');
  for (const [k, v] of Object.entries({ code: 'true', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', response_type: 'code', redirect_uri: redirect, scope: 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload', code_challenge: challenge, code_challenge_method: 'S256', state })) url.searchParams.set(k, v);
  openBrowser(url.toString()); console.error(`Open this URL if the browser did not open:\n${url}`);
  let authorizationCode: string; try { authorizationCode = await code; } finally { server.close(); }
  const response = await fetch('https://platform.claude.com/v1/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: authorizationCode, state, grant_type: 'authorization_code', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', redirect_uri: redirect, code_verifier: verifier }) });
  if (!response.ok) throw new Error(`Claude token exchange failed (${response.status})`);
  const tokens = await response.json() as Record<string, unknown>; const accessToken = String(tokens.access_token); const profile = await claudeProfile(accessToken);
  return { label: profile.label, credential: { accessToken, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null, expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000, accountId: profile.id } };
}

export async function loginCodex(): Promise<{ label: string; credential: OAuthCredential }> {
  const home = await mkdtemp(join(tmpdir(), 'teamai-codex-login-'));
  try {
    const exit = await new Promise<number>((resolveExit, reject) => { const child = spawn('codex', ['login', '--device-auth'], { stdio: 'inherit', env: { ...process.env, CODEX_HOME: home } }); child.once('error', reject); child.once('exit', (code) => resolveExit(code ?? 1)); });
    if (exit !== 0) throw new Error(`codex login exited with ${exit}`);
    return (await importAuth('codex', join(home, 'auth.json')))[0]!;
  } finally { await rm(home, { recursive: true, force: true }); }
}

function openBrowser(url: string): void { const command = platform() === 'darwin' ? 'open' : 'xdg-open'; spawn(command, [url], { detached: true, stdio: 'ignore' }).unref(); }
