import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountPool } from './account-pool.js';
import { claudeGroupArgs } from './groups.js';
import { secureEqual } from './proxy.js';
import { isLoopback } from './reset-credit-control.js';
import { adoptableSessionId, issueClaudeSession } from './storage.js';
import type { TeamAIConfig } from './types.js';

export const CLAUDE_SESSION_PATH = '/claude/sessions';
export const CLAUDE_SESSION_ADOPT_PATH = '/claude/sessions/adopt';
const ADOPT_BODY_LIMIT = 4096;

export type AdoptReply = { sessionId?: string; account?: string; status?: 'adopted' | 'already_bound'; error?: string };

function send(res: ServerResponse, status: number, value: AdoptReply): void { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }

// Recording a conversation that was already running before this relay issued
// IDs (after an upgrade, say) as first bound to an account the administrator
// names. Same gate as issuance: loopback, then the client token. The body
// names the conversation and the account; the relay takes the credential and
// the actual account id from its own pool, and neither is ever sent back.
export async function handleClaudeSessionAdopt(req: IncomingMessage, res: ServerResponse, pool: AccountPool | undefined, token: string, log: (message: string) => void = () => {}): Promise<boolean> {
  if (new URL(req.url || '/', 'http://localhost').pathname !== CLAUDE_SESSION_ADOPT_PATH) return false;
  if (!isLoopback(req.socket.remoteAddress)) { req.resume(); send(res, 403, { error: 'local only' }); return true; }
  if (!secureEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), token)) { req.resume(); send(res, 401, { error: 'Unauthorized' }); return true; }
  if (req.method !== 'POST') { req.resume(); send(res, 405, { error: 'Use POST' }); return true; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > ADOPT_BODY_LIMIT) { send(res, 413, { error: 'Request body too large' }); req.resume(); return true; }
    chunks.push(chunk as Buffer);
  }
  let body: { sessionId?: unknown; account?: unknown };
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { send(res, 400, { error: 'Body must be JSON: {"sessionId": "...", "account": "..."}' }); return true; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { send(res, 400, { error: 'Body must be a JSON object' }); return true; }
  const sessionId = adoptableSessionId(body.sessionId);
  if (!sessionId) { send(res, 400, { error: 'Invalid sessionId: visible ASCII without commas, at most 256 characters, not a prototype property name' }); return true; }
  if (typeof body.account !== 'string' || !body.account.trim()) { send(res, 400, { error: 'Missing account: a Claude account label or id' }); return true; }
  if (!pool) { send(res, 404, { error: 'Account not found among Claude accounts' }); return true; }
  const result = await pool.adoptClaudeSession(sessionId, body.account.trim());
  const label = result.account?.label;
  switch (result.status) {
    case 'adopted':
      log(`Claude session ${sessionId} adopted: first account ${label}`);
      send(res, 201, { sessionId, account: label, status: 'adopted' }); return true;
    case 'already_bound': send(res, 200, { sessionId, account: label, status: 'already_bound' }); return true;
    case 'conflict': send(res, 409, { error: 'Session is already bound to another account; its binding is unchanged' }); return true;
    case 'pending': send(res, 409, { error: 'Session was issued by this relay and is still pending; its first request binds it' }); return true;
    case 'unknown_account': send(res, 404, { error: 'Account not found among Claude accounts' }); return true;
    case 'ambiguous_account': send(res, 400, { error: 'Several Claude accounts have that label; name the account by id' }); return true;
    case 'unusable_account': send(res, 400, { error: `Account cannot take the session: ${result.reason ?? 'unusable'}` }); return true;
    default: send(res, 500, { error: 'Claude session storage unavailable; nothing recorded' }); return true;
  }
}

// `teamai adopt claude`: the request to a running relay's control port.
export async function requestClaudeAdopt(config: TeamAIConfig, sessionId: string, account: string): Promise<{ status: number; body: AdoptReply }> {
  const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
  const response = await fetch(`http://${config.proxy.host}:${port}${CLAUDE_SESSION_ADOPT_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, account }), signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => ({})) as AdoptReply;
  return { status: response.status, body };
}

export async function handleClaudeSessionControl(req: IncomingMessage, res: ServerResponse, token: string, pool?: AccountPool): Promise<boolean> {
  if (req.url !== CLAUDE_SESSION_PATH) return false;
  res.setHeader('content-type', 'application/json');
  if (!secureEqual(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), token)) {
    res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' })); return true;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(JSON.stringify({ error: 'Use POST' })); return true; }
  // A group narrows selection; the relay still generates the conversation ID.
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > ADOPT_BODY_LIMIT) { req.resume(); res.writeHead(413).end(JSON.stringify({ error: 'Request body too large' })); return true; }
    chunks.push(chunk as Buffer);
  }
  let group: string | undefined;
  if (size) {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { group?: unknown };
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Body must be an object');
      if (body.group !== undefined) {
        if (typeof body.group !== 'string' || !pool?.hasGroup(body.group)) throw new Error('Unknown Claude group');
        group = body.group;
      }
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: (error as Error).message })); return true; }
  }
  try { const sessionId = await issueClaudeSession(group); res.writeHead(201).end(JSON.stringify({ sessionId, ...(group === undefined ? {} : { group }) })); }
  catch { res.writeHead(500).end(JSON.stringify({ error: 'Claude session storage unavailable; refusing new session' })); }
  return true;
}

export async function prepareClaudeArgs(input: string[], config: TeamAIConfig): Promise<string[]> {
  const { args, group } = claudeGroupArgs(input, config);
  const named = (name: string): boolean => args.some((arg) => arg === name || arg.startsWith(`${name}=`));
  if (named('--session-id') || named('--fork-session')) throw new Error('TeamAI issues Claude session IDs; --session-id and --fork-session are unsupported. Use --resume for a previously bound session.');
  if (named('--resume') || named('--continue') || args.some((arg) => /^-[^-]*[rc]/.test(arg))) return [...args];
  const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
  const response = await fetch(`http://${config.proxy.host}:${port}${CLAUDE_SESSION_PATH}`, {
    method: 'POST', headers: { authorization: `Bearer ${config.proxy.clientToken}`, 'content-type': 'application/json' }, body: JSON.stringify(group === undefined ? {} : { group }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Cannot register new Claude session (control ${response.status}); check session storage and update/restart the relay if needed`);
  const body = await response.json() as { sessionId?: unknown; group?: unknown };
  if (typeof body.sessionId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(body.sessionId)) throw new Error('Relay returned an invalid Claude session ID');
  if (group !== undefined && body.group !== group) throw new Error('Relay did not confirm the session group; update/restart the relay before launching a grouped session');
  return ['--session-id', body.sessionId, ...args];
}
