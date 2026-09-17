import type { OAuthCredential, ProbeTemplate, Provider } from './types.js';

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'cookie', 'x-api-key']);

function outboundHeaders(incoming: Headers): Headers {
  const headers = new Headers(incoming);
  for (const key of HOP_HEADERS) headers.delete(key);
  headers.delete('authorization');
  return headers;
}

function retryAfter(headers: Headers, fallback = 60_000): number {
  const raw = headers.get('retry-after');
  if (!raw) return fallback;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(7 * 86_400_000, Math.max(1_000, seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(7 * 86_400_000, Math.max(1_000, date - Date.now())) : fallback;
}

async function tokenRefresh(url: string, contentType: string, body: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`OAuth refresh failed (${response.status})`);
  return await response.json() as Record<string, unknown>;
}

function expiry(data: Record<string, unknown>): number {
  if (typeof data.expires_at === 'number') return data.expires_at < 10_000_000_000 ? data.expires_at * 1000 : data.expires_at;
  return Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000;
}

function timestamp(raw: string | null): number | null {
  if (!raw) return null;
  const numeric = Number(raw);
  if (/^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export const claudeProvider: Provider = {
  id: 'claude', label: 'Claude', upstreamBase: 'https://api.anthropic.com', fableModel: 'claude-fable-5-1',
  normalizePath(path) { return path.startsWith('/v1/') || path.startsWith('/api/') ? path : null; },
  buildHeaders(incoming, account) {
    const headers = outboundHeaders(incoming);
    headers.set('authorization', `Bearer ${account.credential.accessToken}`);
    headers.delete('x-api-key');
    return headers;
  },
  rewriteBody(body, account) {
    if (!account.credential.accountId || body.length === 0) return body;
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { metadata?: { user_id?: string } };
      if (parsed.metadata?.user_id) {
        try {
          const identity = JSON.parse(parsed.metadata.user_id) as Record<string, unknown>;
          if (typeof identity.account_uuid === 'string') {
            identity.account_uuid = account.credential.accountId;
            parsed.metadata.user_id = JSON.stringify(identity);
            return Buffer.from(JSON.stringify(parsed));
          }
        } catch { /* unknown user_id shape */ }
      }
    } catch { /* non-JSON passthrough */ }
    return body;
  },
  readQuota(headers) {
    const windows: Record<string, { usage: number | null; resetsAt: number | null }> = {};
    const names = new Set<string>();
    for (const [key] of headers) { const match = /^anthropic-ratelimit-unified-(5h|7d(?:_[a-z0-9]+)?)-(?:utilization|reset)$/i.exec(key); if (match?.[1]) names.add(match[1]); }
    for (const name of names) {
      const usage = Number(headers.get(`anthropic-ratelimit-unified-${name}-utilization`));
      const reset = timestamp(headers.get(`anthropic-ratelimit-unified-${name}-reset`));
      windows[name] = { usage: Number.isFinite(usage) ? usage : null, resetsAt: reset };
    }
    const routing = ['5h', '7d'].map((name) => windows[name]).filter((x) => x?.usage !== null && x?.usage !== undefined).sort((a, b) => (b?.usage ?? 0) - (a?.usage ?? 0))[0];
    return Object.keys(windows).length ? { routingUsage: routing?.usage ?? null, routingResetsAt: routing?.resetsAt ?? null, windows } : null;
  },
  classifyFailure(status, headers) {
    if (status === 401) return { kind: 'auth', retryAfterMs: 0 };
    if (status === 403) return { kind: 'forbidden', retryAfterMs: 30 * 60_000 };
    if (status === 429) {
      const rejected = [...headers].some(([key, value]) => key.startsWith('anthropic-ratelimit-unified-') && key.endsWith('-status') && value === 'rejected');
      return { kind: rejected ? 'quota' : 'transient', retryAfterMs: retryAfter(headers) };
    }
    if (status >= 500) return { kind: 'transient', retryAfterMs: 1_000 };
    return { kind: 'fatal', retryAfterMs: 0 };
  },
  async refresh(credential) {
    if (!credential.refreshToken) throw new Error('No Claude refresh token');
    const data = await tokenRefresh('https://platform.claude.com/v1/oauth/token', 'application/json', JSON.stringify({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e' }));
    return { ...credential, accessToken: String(data.access_token), refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : credential.refreshToken, expiresAt: expiry(data) };
  },
  captureProbe(path, headers, body, sawModelWeekly) {
    if (!path.startsWith('/v1/messages')) return null;
    let parsed: { model?: unknown; system?: unknown };
    try { parsed = JSON.parse(body.toString('utf8')) as { model?: unknown; system?: unknown }; } catch { return null; }
    if (typeof parsed.model !== 'string') return null;
    const query = path.includes('?') ? path.slice(path.indexOf('?')) : '';
    return {
      path: '/v1/messages', model: parsed.model, version: headers.get('anthropic-version') || '2023-06-01',
      beta: headers.get('anthropic-beta'), system: parsed.system ?? null,
      userAgent: headers.get('user-agent'), query, elicitsModelWeekly: sawModelWeekly,
    };
  },
  probeRequest(template, credential) {
    const headers: Record<string, string> = {
      'content-type': 'application/json', 'anthropic-version': template.version,
      authorization: `Bearer ${credential.accessToken}`,
    };
    if (template.beta) headers['anthropic-beta'] = template.beta;
    // Upstream gates newer models on the client version in the user-agent, so a
    // template captured from an older client cannot probe the Fable window it is
    // meant to measure (400 "version X or newer is required"). Float the version
    // to the floor the model needs while preserving the captured client shape.
    const agent = template.userAgent || 'claude-cli/2.1.260 (external, cli)';
    const version = /claude-cli\/(\d+)\.(\d+)\.(\d+)/.exec(agent);
    const tooOld = !version || Number(version[1]) < 2 || (Number(version[1]) === 2 && (Number(version[2]) < 1 || (Number(version[2]) === 1 && Number(version[3]) < 251)));
    headers['user-agent'] = tooOld ? agent.replace(/claude-cli\/[\d.]+/, 'claude-cli/2.1.260') : agent;
    const payload: Record<string, unknown> = { model: template.model, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] };
    if (template.system) payload.system = template.system;
    return { url: `https://api.anthropic.com${template.path}${template.query}`, headers, body: JSON.stringify(payload) };
  },
  async fetchProfile(credential) {
    const response = await fetch('https://api.anthropic.com/api/oauth/profile', { headers: { authorization: `Bearer ${credential.accessToken}`, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Claude profile failed (${response.status})`);
    const data = await response.json() as { account?: { has_claude_max?: boolean; has_claude_pro?: boolean }; organization?: { subscription_status?: string; subscription_created_at?: string; rate_limit_tier?: string; organization_type?: string } };
    return { status: data.organization?.subscription_status ?? null, createdAt: data.organization?.subscription_created_at ?? null, rateLimitTier: data.organization?.rate_limit_tier ?? null, orgType: data.organization?.organization_type ?? null, hasClaudeMax: data.account?.has_claude_max ?? null, hasClaudePro: data.account?.has_claude_pro ?? null, fetchedAt: Date.now() };
  },
};

export const codexProvider: Provider = {
  id: 'codex', label: 'Codex', upstreamBase: 'https://chatgpt.com/backend-api',
  normalizePath(path) {
    const pathname = new URL(path, 'http://localhost').pathname;
    if (['/responses', '/v1/responses', '/codex/responses', '/v1/codex/responses'].includes(pathname)) return '/codex/responses';
    if (['/models', '/v1/models'].includes(pathname)) return '/models';
    return null;
  },
  buildHeaders(incoming, account) {
    const headers = outboundHeaders(incoming);
    headers.set('authorization', `Bearer ${account.credential.accessToken}`);
    headers.set('chatgpt-account-id', account.credential.accountId);
    headers.set('openai-beta', 'responses=experimental');
    headers.set('originator', 'codex_cli_rs');
    return headers;
  },
  rewriteBody(body) { return body; },
  readQuota(headers) {
    const codexWindows = ['primary', 'secondary'].flatMap((window) => {
      const used = Number(headers.get(`x-codex-${window}-used-percent`));
      if (!Number.isFinite(used)) return [];
      const after = Number(headers.get(`x-codex-${window}-reset-after-seconds`));
      const at = headers.get(`x-codex-${window}-reset-at`);
      let reset: number | null = Number.isFinite(after) && after > 0 ? Date.now() + after * 1000 : null;
      if (reset === null && at) { const numeric = Number(at); const parsed = /^\d+$/.test(at) ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric) : Date.parse(at); reset = Number.isFinite(parsed) ? parsed : null; }
      return [{ name: window, usage: Math.max(0, Math.min(1, used / 100)), reset }];
    });
    if (codexWindows.length) {
      const binding = codexWindows.sort((a, b) => b.usage - a.usage)[0]!;
      return { routingUsage: binding.usage, routingResetsAt: binding.reset, windows: Object.fromEntries(codexWindows.map((window) => [window.name, { usage: window.usage, resetsAt: window.reset }])) };
    }
    const remaining = Number(headers.get('x-ratelimit-remaining-requests'));
    const limit = Number(headers.get('x-ratelimit-limit-requests'));
    const usage = Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0 ? 1 - remaining / limit : null;
    const resetRaw = headers.get('x-ratelimit-reset-requests');
    const resetsAt = resetRaw ? Date.parse(resetRaw) : Number.NaN;
    return usage !== null || Number.isFinite(resetsAt) ? { routingUsage: usage, routingResetsAt: Number.isFinite(resetsAt) ? resetsAt : null, windows: { requests: { usage, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null } } } : null;
  },
  classifyFailure(status, headers, body) {
    if (status === 401) return { kind: 'auth', retryAfterMs: 0 };
    if (status === 403) return { kind: 'forbidden', retryAfterMs: 30 * 60_000 };
    if (status === 429) return { kind: /usage_limit|quota|rate_limit_exceeded/i.test(body) ? 'quota' : 'transient', retryAfterMs: retryAfter(headers) };
    if (status >= 500) return { kind: 'transient', retryAfterMs: 1_000 };
    return { kind: 'fatal', retryAfterMs: 0 };
  },
  async refresh(credential: OAuthCredential) {
    if (!credential.refreshToken) throw new Error('No Codex refresh token');
    const data = await tokenRefresh('https://auth.openai.com/oauth/token', 'application/x-www-form-urlencoded', new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refreshToken, client_id: 'app_EMoamEEZ73f0CkXaXp7hrann' }).toString());
    return { ...credential, accessToken: String(data.access_token), refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : credential.refreshToken, expiresAt: expiry(data) };
  },
  async fetchProfile(credential) {
    // ChatGPT has no profile endpoint for Codex, but the plan is carried in the
    // access token's auth claim, so decode it rather than leaving the row blank.
    // A live response header (x-codex-plan-type) supersedes this when one
    // arrives — see readQuota's planFromHeaders.
    const part = credential.accessToken.split('.')[1];
    let plan: string | null = null;
    if (part) {
      try {
        const claims = JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
        const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
        if (auth && typeof auth.chatgpt_plan_type === 'string') plan = auth.chatgpt_plan_type;
      } catch { /* opaque token */ }
    }
    return { status: 'active', createdAt: null, rateLimitTier: plan, orgType: null, hasClaudeMax: null, hasClaudePro: null, fetchedAt: Date.now() };
  },
  captureProbe(path, headers, body) {
    if (path !== '/codex/responses') return null;
    let parsed: { model?: unknown; instructions?: unknown };
    try { parsed = JSON.parse(body.toString('utf8')) as { model?: unknown; instructions?: unknown }; } catch { return null; }
    if (typeof parsed.model !== 'string') return null;
    return {
      path: '/codex/responses', model: parsed.model, version: '', beta: headers.get('openai-beta'),
      system: parsed.instructions ?? null, userAgent: headers.get('user-agent'), query: '', elicitsModelWeekly: false,
    };
  },
  probeRequest(template, credential) {
    const headers: Record<string, string> = {
      'content-type': 'application/json', authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.accountId, 'openai-beta': template.beta || 'responses=experimental',
      originator: 'codex_cli_rs',
    };
    if (template.userAgent) headers['user-agent'] = template.userAgent;
    // The Codex backend rejects anything but a streaming, unstored request and
    // does not accept max_output_tokens at all ("Unsupported parameter"), so the
    // probe cannot be capped the way the Claude one is. Quota headers arrive on
    // the response head, so the body is dropped without being read.
    headers.accept = 'text/event-stream';
    const payload: Record<string, unknown> = { model: template.model, input: [{ role: 'user', content: 'x' }], stream: true, store: false };
    if (template.system) payload.instructions = template.system;
    return { url: `https://chatgpt.com/backend-api${template.path}`, headers, body: JSON.stringify(payload) };
  },
};

export const providers: Record<'claude' | 'codex', Provider> = { claude: claudeProvider, codex: codexProvider };
