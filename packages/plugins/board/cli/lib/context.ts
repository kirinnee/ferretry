/**
 * What this half reads from the shell beyond `client` and `io`. DECISIONS-1 #21 gives the CLI context an environment
 * (`FY_SESSION_ID` and the shell's allowed names); until it lands on `CliContext` the half reads it, and a reader of
 * text files and standard input, from the context when the shell supplies them. Absent, the verb that needs one says
 * so instead of guessing.
 */
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { refuse } from './errors.ts';
import type { TextFiles } from './ports.ts';

export interface ShellExtras {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readText?(path: string): Promise<string>;
}

export function extrasOf(context: unknown, io: TerminalIo): ShellExtras {
  const fromContext = (context ?? {}) as ShellExtras;
  const fromIo = io as unknown as ShellExtras;
  return {
    ...(fromContext.env === undefined ? {} : { env: fromContext.env }),
    ...(fromContext.readText !== undefined
      ? { readText: fromContext.readText.bind(fromContext) }
      : fromIo.readText !== undefined
        ? { readText: fromIo.readText.bind(fromIo) }
        : {}),
  };
}

/**
 * The refusal a verb gives when the shell lacks a facility it needs: the facility named, and why it is missing — the CLI
 * context's environment and file reader are lead decision DECISIONS-1 #21, still pending on the kernel's `CliContext`.
 */
export const missingFacility = (facility: 'environment' | 'file reader', remedy: string): string =>
  `this shell gives Board's verbs no ${facility} yet (the CLI context's ${facility}, DECISIONS-1 #21, is pending): ${remedy}`;

/** The ferret this process runs inside (`FY_SESSION_ID`); blank is absent. */
export function ownFerretOf(extras: ShellExtras): string | undefined {
  const value = extras.env?.FY_SESSION_ID?.trim() ?? '';
  return value === '' ? undefined : value;
}

export function filesOf(extras: ShellExtras): TextFiles {
  return {
    async readText(path: string): Promise<string> {
      if (extras.readText === undefined) {
        return refuse(
          missingFacility(
            'file reader',
            `${path === '-' ? 'standard input' : path} cannot be read; pass the text on the command line instead`,
          ),
        );
      }
      return await extras.readText(path);
    },
  };
}
