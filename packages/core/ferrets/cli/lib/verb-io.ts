import type { TerminalIo, VerbInvocation } from '@ferretry/kernel/manifest';
import { SessionCommandError } from './session/errors.ts';
import type { SessionPresenter } from './session/presenter.ts';
import type { ICellColour, ISessionIo } from './session/ports.ts';
import type { IStopIo } from './stop/types.ts';
import type { IWorktreeOutput } from './worktrees/ports.ts';

/**
 * The verbs' presentation ports over the shell's terminal: stdout for answers, stderr for notes and refusals. It
 * keeps the exit code a controller sets, which is what the verb answers.
 */
export class VerbIo implements ISessionIo, IStopIo, IWorktreeOutput {
  #exitCode = 0;

  constructor(private readonly io: TerminalIo) {}

  get exitCode(): number {
    return this.#exitCode;
  }

  success(message: string): void {
    this.io.out(message);
  }

  report(message: string): void {
    this.io.out(message);
  }

  warn(message: string): void {
    this.io.out(message);
  }

  error(message: string): void {
    this.io.err(message);
  }

  diagnostic(message: string): void {
    this.io.err(message);
  }

  setExitCode(code: number): void {
    this.#exitCode = code;
  }
}

/** The shell's terminal carries no colour: the amber cell is the plain one. */
export const PLAIN: ICellColour = { amber: cell => cell };

/**
 * Runs one verb's work and answers its exit code. A caller mistake or a controller's own refusal is printed by the
 * presenter (2 or 1); a shell refusal (a paused plugin, the daemon's final "no") carries its own exit code and is the
 * shell's to say, so it goes back to it untouched.
 */
export async function guarded(io: VerbIo, presenter: SessionPresenter, work: () => Promise<void>): Promise<number> {
  try {
    await work();
  } catch (error) {
    const shellOwned =
      !(error instanceof SessionCommandError) &&
      error instanceof Error &&
      typeof (error as { exitCode?: unknown }).exitCode === 'number';
    if (shellOwned) throw error;
    presenter.fail(error);
  }
  return io.exitCode;
}

/** The string an option holds (its last, when repeated), under any of its spellings (`--all`, `-a`). */
export function text(invocation: VerbInvocation, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = invocation.options[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  }
  return undefined;
}

/** Whether a switch is on under any of its spellings; `--no-x` and absence are off. */
export function on(invocation: VerbInvocation, ...names: readonly string[]): boolean {
  return names.some(name => invocation.options[name] === true || invocation.options[name] === 'true');
}

/** Whether an option was typed at all, under any of its spellings. */
export function typed(invocation: VerbInvocation, ...names: readonly string[]): boolean {
  return names.some(name => invocation.options[name] !== undefined);
}

/** The positional words joined back into the text the caller typed, or undefined when there were none. */
export function joined(parts: readonly string[]): string | undefined {
  const value = parts.join(' ').trim();
  return value === '' ? undefined : value;
}

/** Every value a repeatable option was given, in order (`--harness-flag a --harness-flag b`); a switch gives none. */
export function list(invocation: VerbInvocation, name: string): readonly string[] {
  const value = invocation.options[name];
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value : [];
}

/** A numeric option as a number (`NaN` for a word, which the caller's validator refuses), or undefined when absent. */
export function count(invocation: VerbInvocation, name: string): number | undefined {
  const value = text(invocation, name);
  return value === undefined ? undefined : Number(value);
}

/** A tri-state switch: `true` for `--name`, `false` for `--no-name`, undefined when neither was typed. */
export function choice(invocation: VerbInvocation, name: string): boolean | undefined {
  const value = invocation.options[name];
  if (value === undefined) return undefined;
  return value === true || value === 'true';
}
