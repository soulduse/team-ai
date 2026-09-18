import assert from 'node:assert/strict';
import test from 'node:test';
import { legacyPorts } from '../src/runtime.js';
import { defaultConfig } from '../src/storage.js';
import type { TeamAIConfig } from '../src/types.js';

const config = (proxy: Partial<TeamAIConfig['proxy']>): TeamAIConfig => ({ ...defaultConfig(), proxy: { ...defaultConfig().proxy, ...proxy } });
const defaults = defaultConfig().proxy;

test('a moved port still answers on the built-in default', () => {
  // The case this exists for: a session started before the config was edited
  // holds the old port in its environment and cannot be told about the new one.
  const moved = config({ claudePort: defaults.claudePort + 10, codexPort: defaults.codexPort + 10 });
  assert.deepEqual(legacyPorts(moved, 'claude'), [defaults.claudePort]);
  assert.deepEqual(legacyPorts(moved, 'codex'), [defaults.codexPort]);
});

test('an unmoved port lists nothing to alias', () => {
  assert.deepEqual(legacyPorts(config({}), 'claude'), []);
  assert.deepEqual(legacyPorts(config({}), 'codex'), []);
});

test('explicitly declared legacy ports are kept alongside the default', () => {
  const moved = config({ claudePort: 4000, legacyPorts: { claude: [3900, 3901] } });
  assert.deepEqual(legacyPorts(moved, 'claude'), [3900, 3901, defaults.claudePort]);
});

test('the live port is never aliased to itself, however it is listed', () => {
  const moved = config({ claudePort: 3900, legacyPorts: { claude: [3900, 3901] } });
  assert.equal(legacyPorts(moved, 'claude').includes(3900), false);
  // A config left on the default must not try to bind its own port twice.
  const same = config({ legacyPorts: { claude: [defaults.claudePort] } });
  assert.deepEqual(legacyPorts(same, 'claude'), []);
});

test('duplicate and invalid entries are dropped', () => {
  const moved = config({ claudePort: 4000, legacyPorts: { claude: [3900, 3900, 0, -1, 1.5] } });
  assert.deepEqual(legacyPorts(moved, 'claude'), [3900, defaults.claudePort]);
});
