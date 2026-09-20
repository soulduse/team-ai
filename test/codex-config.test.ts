import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'smol-toml';
import { relayedCodexConfig } from '../src/codex-config.js';

test('nested clients inherit relay while preserving model, MCP and project settings', () => {
  const original = `model = "gpt-5.6-luna"
model_provider = "openai"
model_reasoning_effort = "max"
[mcp_servers.example]
command = "node"
args = ["server.js"]
[projects."/tmp/game"]
trust_level = "trusted"
[model_providers.teamai]
base_url = "http://127.0.0.1:1/v1"
requires_openai_auth = true
`;
  const result = relayedCodexConfig(original, '127.0.0.1', 3467);
  const parsed = parse(result);
  assert.equal(parsed.model_provider, 'teamai');
  assert.equal(parsed.model, 'gpt-5.6-luna');
  assert.equal(parsed.model_reasoning_effort, 'max');
  assert.deepEqual(parsed.mcp_servers, parse(original).mcp_servers);
  assert.deepEqual(parsed.projects, parse(original).projects);
  assert.deepEqual(parsed.model_providers, { teamai: {
    name: 'TeamAI Codex Relay', base_url: 'http://127.0.0.1:3467/v1',
    env_key: 'TEAMAI_PROXY_TOKEN', wire_api: 'responses',
    request_max_retries: 0, stream_max_retries: 5, stream_idle_timeout_ms: 1_800_000,
  } });
  assert.equal(relayedCodexConfig(result, '127.0.0.1', 3467), result);
});

test('empty config is supported; invalid config fails instead of falling back to direct auth', () => {
  assert.equal(parse(relayedCodexConfig('', 'localhost', 3457)).model_provider, 'teamai');
  assert.throws(() => relayedCodexConfig('invalid = [', 'localhost', 3457));
});

test('a high-effort turn is not cut mid-reasoning by the default SSE idle timeout', () => {
  // Codex declares a stream dead after stream_idle_timeout_ms with no SSE event
  // (default 300s). gpt-5.6-luna at --effort max routinely thinks for longer
  // than that before its first token, so the default cut live turns and the
  // client reconnected silently — indistinguishable from a hung session
  // (2026-09-20). A nested `codex exec` reads this file, not the -c flags, so
  // the window has to survive here.
  const provider = (parse(relayedCodexConfig('', '127.0.0.1', 3467)).model_providers as Record<string, Record<string, unknown>>).teamai!;
  assert.equal(provider.stream_idle_timeout_ms, 1_800_000);
  // Failover is the relay's job, but a mid-body SSE cut is still the client's
  // to retry: neither may be dropped while widening the idle window.
  assert.equal(provider.request_max_retries, 0);
  assert.equal(provider.stream_max_retries, 5);
});
