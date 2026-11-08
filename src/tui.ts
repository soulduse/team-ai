import { loginClaude, loginCodex } from './auth.js';
import { captureDashboard } from './capture.js';
import { applyConfig, describeApply } from './config-apply.js';
import { copyImageToClipboard, revealInFolder } from './desktop.js';
import { buildFrame, displayOrder, frozenOrder, navigationOrder, orderOptions, ESC, type CreditPicker, type FrameMode } from './frame.js';
import { createHostTracker } from './host-metrics.js';
import { applyRoutes, describeReload } from './route-config.js';
import { openRouteEditor, routeEditorKey, type RouteEditor } from './route-editor.js';
import { groupEditorKey, openGroupEditor, type GroupEditor } from './group-editor.js';
import { liveState } from './runtime.js';
import { clearSessionGroups, loadConfig, loadSessions, loadState, removeAccount, renameSessionGroup, updateConfig, upsertAccount } from './storage.js';
import type { ResetCredit, StoredAccount } from './types.js';

export async function runTui(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('TUI requires a terminal');
  let selectedId: string | null = null; let mode: FrameMode = 'normal'; let message = ''; let busy = false; let closed = false;
  // Least-spent first by default: the dashboard is mostly read to answer "which
  // account has room left", and that ordering answers it at a glance. 'c' puts
  // it back in configured order for anyone reading it as a roster.
  let sortByHeadroom = true;
  let credits: CreditPicker | undefined; let creditList: ResetCredit[] = []; let creditAccount: string | null = null;
  let routeEditor: RouteEditor | undefined;
  let groupEditor: GroupEditor | undefined;
  // The roster captured when priority mode opened. While it is set, rows are
  // drawn and walked in that order, so saving a rank does not move the row
  // under the cursor; leaving the mode clears it and the next frame sorts again.
  let frozen: string[] | null = null;
  const rows = async (): Promise<StoredAccount[]> => { const config = await loadConfig(); const state = await loadState(); return navigationOrder(config, frozen ? frozenOrder(config.accounts, frozen) : displayOrder(config.accounts, state, sortByHeadroom, orderOptions(config))); };
  const selected = (accounts: StoredAccount[]): StoredAccount | null => accounts.find((account) => account.credentialId === selectedId) || accounts[0] || null;

  // This PC's CPU/RAM for the header, re-sampled on every redraw (the 500 ms
  // tick), so the CPU% is the load over the last half second.
  const host = createHostTracker();
  const screen = startScreen(process.stdout, async ({ width, height }) => {
    const config = await loadConfig(); const state = await liveState(await loadState()); const current = selected(navigationOrder(config, frozen ? frozenOrder(config.accounts, frozen) : displayOrder(config.accounts, state, sortByHeadroom, orderOptions(config)))); if (current && !selectedId) selectedId = current.credentialId;
    return buildFrame(config, state, { width, height, selectedId, mode, message, sortByHeadroom, frozen: frozen ?? undefined, credits, routes: routeEditor, groups: groupEditor, host: host.sample() });
  });
  const render = (): Promise<void> => screen.render();

  const move = async (delta: number): Promise<void> => { const accounts = await rows(); const index = Math.max(0, accounts.findIndex((a) => a.credentialId === selectedId)); selectedId = accounts[Math.min(accounts.length - 1, Math.max(0, index + delta))]?.credentialId || null; };
  // Every account change is saved, then applied to the running server in
  // place — never by restarting it, which cut every response in flight. Only
  // a stopped server is started. Silent when it simply applied.
  const apply = async (done = ''): Promise<void> => { let note: string; try { note = describeApply(await applyConfig()); } catch (error) { note = (error as Error).message; } message = [done, note === 'applied' ? '' : note].filter(Boolean).join(' — '); };
  const mutate = async (fn: (account: StoredAccount, accounts: StoredAccount[]) => void): Promise<void> => { const saved = await updateConfig((config) => { const account = selected(config.accounts); if (!account) return false; fn(account, config.accounts); }); if (saved) await apply(); };
  // Fleet-wide quota re-measure. The server owns the pools (and the committed
  // probe template), so this asks it over the local control channel rather than
  // restarting it — a restart only re-read profiles and left every bar blank.
  const remeasure = async (): Promise<void> => {
    busy = true; message = 'Re-measuring quota...'; await render();
    try {
      const config = await loadConfig();
      const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
      const response = await fetch(`http://${config.proxy.host}:${port}/probe`, { headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(90_000) });
      if (!response.ok) throw new Error(`control ${response.status}`);
      const result = await response.json() as { targets: number; measured: number; ready: boolean; added: number; removed: number };
      const fleet = [result.added ? `+${result.added}` : '', result.removed ? `-${result.removed}` : ''].filter(Boolean).join(' ');
      message = !result.ready
        ? 'No probe template yet — run one request through the proxy first'
        : `Re-measured ${result.measured}/${result.targets} account(s)${fleet ? ` (${fleet})` : ''}`;
    } catch (error) { message = `Re-measure failed: ${(error as Error).message}`; }
    finally { busy = false; }
  };
  // Snapshot what is on screen — same width, cursor and sort — with account
  // addresses masked, so the result can be pasted somewhere public as is.
  // Then hand it over: reveal it in the file manager and put the image on the
  // clipboard, saying which of those actually happened.
  const capture = async (): Promise<void> => {
    busy = true;
    try {
      const result = await captureDashboard({ level: 'partial', width: terminalSize(process.stdout).width, selectedId, mode, sortByHeadroom, frozen: frozen ?? undefined });
      const [copied, revealed] = await Promise.all([copyImageToClipboard(result.png), revealInFolder(result.png)]);
      const extras = [copied ? 'copied to clipboard' : 'clipboard unavailable', revealed ? 'opened folder' : ''].filter(Boolean).join(', ');
      message = `Captured ${result.png.slice(result.png.lastIndexOf('/') + 1)} — ${extras}`;
    } catch (error) { message = `Capture failed: ${(error as Error).message}`; }
    finally { busy = false; }
  };

  // Reset credits by hand ('t' on a Codex row). The server holds the tokens,
  // so the list and the redemption both go through the control port.
  const control = async (path: string, method = 'GET'): Promise<Response> => {
    const config = await loadConfig(); const port = config.proxy.controlPort ?? config.proxy.claudePort + 100;
    return fetch(`http://${config.proxy.host}:${port}${path}`, { method, headers: { authorization: `Bearer ${config.proxy.clientToken}` }, signal: AbortSignal.timeout(60_000) });
  };
  const openCredits = async (): Promise<void> => {
    const account = selected(await rows());
    if (!account || account.provider !== 'codex') { message = 'Reset credits: select a Codex account first'; return; }
    creditAccount = account.credentialId; mode = 'credits'; credits = { account: account.label, phase: 'loading', items: [], index: 0 }; busy = true; await render();
    try {
      const response = await control(`/codex/reset-credits?account=${encodeURIComponent(account.credentialId)}`);
      const body = await response.json() as { credits?: ResetCredit[]; error?: string };
      if (!response.ok) throw new Error(body.error || `control ${response.status}`);
      // Listed soonest-to-expire first, so the default choice is that one.
      creditList = body.credits ?? []; credits = { ...credits, phase: 'pick', items: creditList, index: 0 };
    } catch (error) { mode = 'normal'; credits = undefined; message = `Reset credits failed: ${(error as Error).message}`; }
    finally { busy = false; }
  };
  const redeemCredit = async (): Promise<void> => {
    if (!credits || !creditAccount) return;
    const chosen = creditList[credits.index]; credits = { ...credits, phase: 'applying' }; busy = true; await render();
    try {
      const response = await control(`/codex/reset-credit?account=${encodeURIComponent(creditAccount)}${chosen ? `&credit_id=${encodeURIComponent(chosen.id)}` : ''}`, 'POST');
      const body = await response.json() as { outcome?: string; error?: string };
      credits = { ...credits, phase: 'done', result: body.outcome ?? body.error ?? `error ${response.status}` };
    } catch (error) { credits = { ...credits, phase: 'done', result: `error: ${(error as Error).message}` }; }
    finally { busy = false; }
  };

  // Model routes ('g'), for the provider of the selected row. Every change is
  // checked by the server's own route parser before it is written, so nothing
  // saved here can stop the relay from starting; a running server then
  // re-reads the routes in place. A failed reload leaves the (valid) file
  // saved and says so.
  const openRoutes = async (): Promise<void> => {
    const account = selected(await rows());
    routeEditor = openRouteEditor(await loadConfig(), account?.provider ?? 'claude'); mode = 'routes';
  };
  const routeKey = async (key: string): Promise<void> => {
    const current = routeEditor; if (!current) return;
    try { routeEditor = await pressRouteKey(current, key, async (pending) => { routeEditor = pending; busy = true; await render(); }); }
    catch (error) { routeEditor = { ...current, error: (error as Error).message }; }
    finally { busy = false; }
    if (!routeEditor) mode = 'normal';
  };
  const openGroups = async (): Promise<void> => { const config = await loadConfig(); groupEditor = openGroupEditor(config); const selectedIndex = groupEditor.accounts.findIndex((account) => account.credentialId === selectedId); if (selectedIndex >= 0) groupEditor.accountIndex = selectedIndex; mode = 'groups'; };
  const groupKey = async (key: string): Promise<void> => {
    const current = groupEditor; if (!current) return;
    try {
      groupEditor = await pressGroupKey(current, key, async (pending) => { groupEditor = pending; busy = true; await render(); }, async (notice) => { await apply(notice); });
    } catch (error) { groupEditor = { ...current, error: (error as Error).message }; }
    finally { busy = false; }
    if (!groupEditor) mode = 'normal';
  };

  const add = async (provider: 'claude' | 'codex'): Promise<void> => { busy = true; message = `Logging into ${provider}...`; process.stdin.setRawMode(false); await render(); try { const result = provider === 'claude' ? await loginClaude({ interactive: false }) : await loginCodex(); const account = await upsertAccount(provider, result.label, result.credential); selectedId = account.credentialId; await apply(`Added ${account.label}`); } catch (error) { message = (error as Error).message; } finally { process.stdin.setRawMode(true); busy = false; mode = 'normal'; } };

  process.stdout.write(`${ESC}?1049h${ESC}?25l`); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8'); await render(); const timer = setInterval(() => void render(), 500);
  await new Promise<void>((resolve) => process.stdin.on('data', async (key: string) => {
    if (busy) return; message = '';
    if (key === '' || (mode === 'normal' && key === 'q')) { closed = true; resolve(); return; }
    if (mode === 'routes' && routeEditor) await routeKey(key);
    else if (mode === 'groups' && groupEditor) await groupKey(key);
    else if (key === '\x1b' || mode === 'help') { if (mode === 'order') frozen = null; mode = 'normal'; credits = undefined; }
    else if (mode === 'credits' && credits) {
      if (credits.phase === 'pick' && credits.items.length) {
        if (key === '\x1b[A' || key === 'k') credits = { ...credits, index: Math.max(0, credits.index - 1) };
        else if (key === '\x1b[B' || key === 'j') credits = { ...credits, index: Math.min(credits.items.length - 1, credits.index + 1) };
        else if (key === '\r') credits = { ...credits, phase: 'confirm' };
      } else if (credits.phase === 'confirm') {
        if (key === 'y') await redeemCredit(); else if (key === 'n') credits = { ...credits, phase: 'pick' };
      }
    }
    else if (mode === 'add') { if (key === '1' || key === 'c') await add('claude'); else if (key === '2' || key === 'x') await add('codex'); }
    else if (mode === 'delete') { if (key === 'y' || key === '\r') { const account = selected(await rows()); if (account) { await removeAccount(account.credentialId); selectedId = null; await apply(`Deleted ${account.label}`); } mode = 'normal'; } }
    else if (mode === 'order') {
      const step = await pressOrderKey(selectedId, key);
      if (step.saved) await apply(); else if (step.move) await move(step.move); else if (step.done) { mode = 'normal'; frozen = null; }
    } else {
      if (key === '\x1b[A' || key === 'k') await move(-1); else if (key === '\x1b[B' || key === 'j') await move(1);
      else if (key === 'e') await mutate((account) => { account.enabled = !account.enabled; });
      else if (key === 's') await mutate((account, accounts) => { for (const other of accounts.filter((x) => x.provider === account.provider && x.priority === 0)) other.priority = null; account.priority = 0; });
      else if (key === 'o') { const config = await loadConfig(); frozen = displayOrder(config.accounts, await loadState(), sortByHeadroom, orderOptions(config)).map((account) => account.credentialId); mode = 'order'; } else if (key === 'd') mode = 'delete'; else if (key === 'a') mode = 'add'; else if (key === 'R') { await remeasure(); } else if (key === 't') { await openCredits(); } else if (key === 'g') { await openRoutes(); } else if (key === 'G') { await openGroups(); } else if (key === 'p') { await capture(); } else if (key === '?') mode = 'help';
      else if (key === 'c') { sortByHeadroom = !sortByHeadroom; message = sortByHeadroom ? 'Sorted by remaining quota' : 'Sorted by configured order'; }
    }
    await render();
  }));
  clearInterval(timer); screen.stop(); if (closed) { process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write(`${ESC}?25h${ESC}?1049l`); }
}

// The terminal's size as the frame should be drawn: its real columns and
// rows, so a phone viewing the same terminal at 46 columns gets a 46-column
// frame rather than an 80-column one wrapped onto two lines each.
export function terminalSize(out: { columns?: number; rows?: number }): { width: number; height: number } {
  return { width: Math.max(20, out.columns || 120), height: Math.max(4, out.rows || 40) };
}

export interface TerminalOut { columns?: number; rows?: number; write(text: string): unknown; on(event: 'resize', listener: () => void): unknown; off(event: 'resize', listener: () => void): unknown }

// Draws frames to the terminal at its current size, and again the moment
// the size changes (Node turns SIGWINCH into 'resize' on stdout). The frame
// after a resize clears the screen first: the old frame, reflowed to the new
// width, would otherwise leave pieces outside the new one. A frame whose
// size changed while its data was loading is dropped; the resize's own
// redraw follows with the right size.
export function startScreen(out: TerminalOut, draw: (size: { width: number; height: number }) => Promise<string[]>): { render(): Promise<void>; stop(): void } {
  let wipe = false;
  const render = async (): Promise<void> => {
    const size = terminalSize(out); const lines = await draw(size); const now = terminalSize(out);
    if (now.width !== size.width || now.height !== size.height) return;
    const text = `${wipe ? `${ESC}2J` : ''}${ESC}H${lines.join('\n')}`; wipe = false;
    out.write(text);
  };
  const resized = (): void => { wipe = true; void render(); };
  out.on('resize', resized);
  return { render, stop: () => { out.off('resize', resized); } };
}

// One key in the route editor, saving when the key commits a change: through
// applyRoutes (the server's own parser, then the write, then a reload), and
// back to the list on the saved route. A refused save keeps the screen as it
// was with the reason; a failed reload keeps the saved file and says so.
// Returns undefined when the key closes the editor. onSaving sees the screen
// before the save starts, so it can be drawn while the write is in progress.
export async function pressRouteKey(editor: RouteEditor, key: string, onSaving: (editor: RouteEditor) => Promise<void> = async () => {}): Promise<RouteEditor | undefined> {
  const result = routeEditorKey(editor, key);
  if (result.close) return undefined;
  if (!result.save) return result.editor;
  const save = result.save; await onSaving(result.editor);
  try {
    const outcome = await applyRoutes(save.provider, save.routes, save.expected);
    const reopened = openRouteEditor(await loadConfig(), save.provider, save.focus, `${save.notice} — ${describeReload(outcome)}`);
    return outcome.status === 'failed' ? { ...reopened, notice: undefined, warning: `${save.notice}: ${describeReload(outcome)}` } : reopened;
  } catch (error) { return { ...result.editor, phase: result.editor.phase === 'delete' ? 'list' : result.editor.phase, error: (error as Error).message }; }
}

// One group-editor key, including the atomic config write and live apply. The
// hooks keep the screen testable without a terminal or a running relay.
export async function pressGroupKey(editor: GroupEditor, key: string, onSaving: (editor: GroupEditor) => Promise<void> = async () => {}, applyChange: (notice: string) => Promise<void> = async () => {}): Promise<GroupEditor | undefined> {
  const result = groupEditorKey(editor, key);
  if (result.close) return undefined;
  if (!result.save) return result.editor;
  const save = result.save; await onSaving(result.editor);
  if (save.session?.type === 'remove-members') {
    const sessions = await loadSessions();
    const blocked = save.session.removals.find((removal) => Object.values(sessions).some((binding) => binding.provider === 'claude' && binding.group === removal.group && binding.accountId === removal.accountId));
    if (blocked) return { ...editor, error: `Cannot remove ${blocked.accountId} from ${blocked.group}: a bound Claude session still uses this account` };
  }
  await updateConfig((config) => { config.groups = Object.keys(save.groups).length ? save.groups : {}; });
  if (save.session?.type === 'delete') await clearSessionGroups(new Set([save.session.name]));
  if (save.session?.type === 'rename') await renameSessionGroup(save.session.from, save.session.to);
  await applyChange(save.notice);
  return openGroupEditor(await loadConfig(), save.focus, save.notice);
}

// Priority mode ('o'). ←/→ (or h/l) take the selected account's priority one
// step down or up — #1 is the floor, there is no ceiling, and from auto ← lands
// on #1 and → on #1 — and a/c put it back to auto. ↑/↓ (or k/j) move to another
// account without leaving the mode; Enter leaves it (Esc too, handled before
// any mode). Each change is saved the moment it is made, and nothing is undone
// on the way out. A key that would leave the value as it is (← at #1, a on
// auto) writes nothing, so nothing is sent to the relay for it.
export function orderKey(priority: number | null, key: string): { priority?: number | null; move?: -1 | 1; done?: true } {
  const next = key === '\x1b[D' || key === 'h' ? Math.max(1, (priority ?? 2) - 1) : key === '\x1b[C' || key === 'l' ? (priority ?? 0) + 1 : key === 'a' || key === 'c' ? null : undefined;
  if (next !== undefined) return next === priority ? {} : { priority: next };
  return key === '\x1b[A' || key === 'k' ? { move: -1 } : key === '\x1b[B' || key === 'j' ? { move: 1 } : key === '\r' ? { done: true } : {};
}

// One key in priority mode against config.json: the change orderKey asks for
// is written for the selected account (the first one when none is), and
// `saved` says whether anything was, so the caller knows to apply it.
export async function pressOrderKey(selectedId: string | null, key: string): Promise<{ saved: boolean; move?: -1 | 1; done?: true }> {
  let step: ReturnType<typeof orderKey> = {};
  const saved = await updateConfig((config) => {
    const account = config.accounts.find((a) => a.credentialId === selectedId) || config.accounts[0];
    step = orderKey(account?.priority ?? null, key);
    if (!account || step.priority === undefined) return false;
    account.priority = step.priority;
  });
  return saved ? { saved: true } : { saved: false, move: step.move, done: step.done };
}
