// Launching another CLI (claude, codex) by name. On macOS and Linux spawn()
// finds it on PATH as is. On Windows an npm-installed CLI is a .cmd shim, which
// spawn() will not run without a shell (Node refuses .cmd/.bat since
// CVE-2024-27980), so the shim is looked up on PATH and run through cmd.exe
// with every argument escaped — cmd.exe would otherwise act on a `&` or `|` in
// a prompt. The escaping follows cross-spawn's.
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface Launch { file: string; args: string[]; windowsVerbatimArguments?: boolean }

const META = /([()\][%!^"`<>&|;, *?])/g;

function escapeArgument(arg: string, doubleEscape: boolean): string {
  // Backslashes only need doubling when they end up in front of a quote.
  let quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`.replace(META, '^$1');
  // A .cmd shim re-parses its %* once more, so its arguments are escaped twice.
  if (doubleEscape) quoted = quoted.replace(META, '^$1');
  return quoted;
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of dirs) for (const ext of exts) { const candidate = join(dir, name + ext.toLowerCase()); if (existsSync(candidate)) return candidate; }
  return null;
}

export function launchCommand(name: string, args: string[], platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Launch {
  if (platform !== 'win32') return { file: name, args };
  const found = findOnPath(name, env);
  // Not found: hand the bare name to spawn so the caller sees the usual ENOENT.
  if (!found) return { file: name, args };
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args };
  const line = [found.replace(META, '^$1'), ...args.map((arg) => escapeArgument(arg, true))].join(' ');
  return { file: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true };
}
