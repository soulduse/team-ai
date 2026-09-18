import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureDashboard } from '../src/capture.js';

// A home with two real-looking accounts and an activity log that names them,
// so a leak through any of the three routes to the screen would show up.
async function seedHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamai-capture-'));
  const account = (label: string, provider: 'claude' | 'codex') => ({ id: label, provider, label, enabled: true, priority: null, credentialId: `cred-${label}`, createdAt: '2026-01-01T00:00:00Z' });
  await writeFile(join(root, 'config.json'), JSON.stringify({ version: 1, proxy: { host: '127.0.0.1', claudePort: 3456, codexPort: 3457, clientToken: 'tai-top-secret-token' }, switchThreshold: 0.98, maxConcurrentPerAccount: 3, accounts: [account('alice.long.address@example.com', 'claude'), account('bob@example.com', 'codex')] }));
  await writeFile(join(root, 'state.json'), JSON.stringify({ version: 1, accounts: { 'cred-alice.long.address@example.com': { usage: 0.4, resetsAt: Date.now() + 3_600_000, cooldownUntil: null, lastUsed: null, error: null, windows: { '5h': { usage: 0.4, resetsAt: Date.now() + 3_600_000 }, '7d_oi': { usage: 1, resetsAt: Date.now() + 86_400_000 } } } }, events: [{ at: Date.now(), message: 'Claude POST /v1/messages → alice.long.address@example.com 429 quota; failover' }, { at: Date.now(), message: 'Codex POST /v1/responses → bob@example.com 200' }] }));
  return root;
}

test('capture writes a text and a png with every address masked', async () => {
  const root = await seedHome(); process.env.TEAMAI_HOME = root;
  try {
    const result = await captureDashboard({ level: 'partial', width: 120, message: 'Added bob@example.com' });
    const text = await readFile(result.text, 'utf8');
    assert.equal(text.includes('alice'), false);
    assert.equal(text.includes('bob@'), false);
    assert.equal(text.includes('example.com'), false);
    assert.equal(text.includes('tai-top-secret-token'), false);
    assert.match(text, /al•+s@ex•+\.com/);
    assert.match(text, /7d Fable/);
    assert.match(text, /failover/);
    assert.equal((await stat(result.text)).mode & 0o777, 0o600);
    const png = await readFile(result.png);
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(result.png.startsWith(join(root, 'captures')), true);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('full redaction numbers accounts and honours --out', async () => {
  const root = await seedHome(); process.env.TEAMAI_HOME = root; const out = join(root, 'elsewhere');
  try {
    const result = await captureDashboard({ level: 'full', outDir: out });
    const text = await readFile(result.text, 'utf8');
    assert.match(text, /account #1/); assert.match(text, /account #2/);
    assert.equal(text.includes('@'), false);
    assert.equal(result.png.startsWith(out), true);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('two captures in the same second get distinct files', async () => {
  const root = await seedHome(); process.env.TEAMAI_HOME = root;
  try {
    const first = await captureDashboard({ level: 'full' }); const second = await captureDashboard({ level: 'partial' });
    assert.notEqual(first.text, second.text); assert.notEqual(first.png, second.png);
    assert.match(await readFile(first.text, 'utf8'), /account #1/);
    assert.match(await readFile(second.text, 'utf8'), /al•+s@/);
  } finally { delete process.env.TEAMAI_HOME; }
});

test('none keeps labels for a private capture', async () => {
  const root = await seedHome(); process.env.TEAMAI_HOME = root;
  try {
    const text = await readFile((await captureDashboard({ level: 'none' })).text, 'utf8');
    assert.match(text, /bob@example\.com/);
  } finally { delete process.env.TEAMAI_HOME; }
});
