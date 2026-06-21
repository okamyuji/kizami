import type { HookRuntime } from '@/checkpoint/types';

export type HookOwnership = 'managed' | 'historical' | 'unrelated';

const MANAGED_MARKER = '# kizami-managed';

const KNOWN_EXECUTABLES = new Set(['kizami']);
const KNOWN_SUBCOMMANDS = new Set(['inject', 'recall', 'save']);
const KNOWN_FLAGS = ['--stdin', '--runtime'];

function resolveExecutable(command: string): string | undefined {
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return undefined;

  let exec = parts[0];
  // Strip path prefixes
  const lastSlash = exec.lastIndexOf('/');
  if (lastSlash >= 0) exec = exec.slice(lastSlash + 1);

  return exec;
}

function parseArgVector(command: string): { exec: string; args: string[] } | undefined {
  const stripped = command
    .replace(/^["']|["']$/g, '')
    .replace(/^\s*(?:nohup\s+)?/, '')
    .trim();

  const parts = stripped.split(/\s+/);
  if (parts.length < 2) return undefined;

  const exec = resolveExecutable(parts[0]);
  if (!exec) return undefined;

  return { exec, args: parts.slice(1) };
}

export function classifyJsonLifecycleCommand(
  command: string,
  event: string,
  runtime: HookRuntime
): HookOwnership {
  void event;
  void runtime;

  if (command.includes(MANAGED_MARKER)) return 'managed';

  // Reject commands with shell operators that indicate chaining/piping
  if (/[|;&<>]/.test(command)) return 'unrelated';

  const parsed = parseArgVector(command);
  if (!parsed) return 'unrelated';

  if (!KNOWN_EXECUTABLES.has(parsed.exec)) return 'unrelated';

  // Check for recognized subcommand + --stdin pattern
  const subcommand = parsed.args[0];
  if (!subcommand || !KNOWN_SUBCOMMANDS.has(subcommand)) return 'unrelated';

  const hasStdin = parsed.args.includes('--stdin');
  if (!hasStdin) return 'unrelated';

  // Check for extra unknown arguments (pipes, redirects, etc.)
  for (const arg of parsed.args.slice(1)) {
    if (arg === '--stdin') continue;
    if (arg.startsWith('--runtime')) continue;
    if (KNOWN_FLAGS.includes(arg)) continue;
    if (arg === runtime || arg === 'claude' || arg === 'codex' || arg === 'kimi') continue;
    return 'unrelated';
  }

  return 'historical';
}

export function isHistoricalLifecycleCommand(
  command: string,
  event: string,
  runtime: HookRuntime
): boolean {
  return classifyJsonLifecycleCommand(command, event, runtime) === 'historical';
}
