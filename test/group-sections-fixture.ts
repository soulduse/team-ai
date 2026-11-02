import { buildFrame, type FrameView } from '../src/frame.js';
import { stripAnsi } from '../src/columns.js';
import type { PersistedState, StoredAccount, TeamAIConfig } from '../src/types.js';

export function groupSectionFixture(grouped = true): { config: TeamAIConfig; state: PersistedState } {
  const account = (id: string, label: string, provider: 'claude' | 'codex' = 'claude'): StoredAccount => ({ id, label, provider, enabled: true, priority: null, credentialId: `credential-${id}`, createdAt: '2026-01-01T00:00:00Z' });
  const config: TeamAIConfig = {
    version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'synthetic' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3,
    accounts: [account('c', 'charlie'), account('b', 'bravo'), account('a', 'alpha'), account('u', '미지정'), account('x', 'codex', 'codex')],
    ...(grouped ? { groups: { master: ['alpha', 'b'], worker: ['b', 'c'] } } : {}),
  };
  const state: PersistedState = { version: 1, accounts: {}, next: { claude: { general: 'credential-a', fable: null, routes: {} } } };
  for (const [id, usage] of Object.entries({ a: 0.25, b: 0.5, c: 1, u: 0.1 })) state.accounts[`credential-${id}`] = { usage, resetsAt: null, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage, resetsAt: null }, '7d': { usage, resetsAt: null } } };
  return { config, state };
}

export function sectionFrame(grouped: boolean, width: number, view: Partial<FrameView> = {}): string[] {
  const { config, state } = groupSectionFixture(grouped);
  return buildFrame(config, state, { width, selectedId: 'credential-b', mode: 'normal', message: '', sortByHeadroom: false, ...view }).map(stripAnsi).map((line) => line.trimEnd());
}
