import { parse, stringify, type TomlTable } from 'smol-toml';

/** Persist routing in the isolated home so nested `codex exec` inherits it.
 * CLI -c flags alone apply only to the outer process. Never serialize tokens.
 */
export function relayedCodexConfig(original: string, host: string, port: number): string {
  const config = parse(original);
  config.model_provider = 'teamai';
  const providers = (config.model_providers ?? {}) as TomlTable;
  providers.teamai = {
    name: 'TeamAI Codex Relay', base_url: `http://${host}:${port}/v1`,
    env_key: 'TEAMAI_PROXY_TOKEN', wire_api: 'responses',
    request_max_retries: 0, stream_max_retries: 5,
    // Mirrors the -c override in cli.ts: a high-effort turn can think for far
    // longer than Codex's 300s default before emitting its first SSE event, and
    // a nested `codex exec` reads this file rather than those flags.
    stream_idle_timeout_ms: 1_800_000,
  };
  config.model_providers = providers;
  return stringify(config);
}
