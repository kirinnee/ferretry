import type {
  InputTarget,
  InputTargetFacts,
  ObserveResult as VaultObserveResult,
  ProfileProgram,
  TypeOptions,
  TypeResult,
} from '@ferretry/core-vault/contract';

/**
 * The seams the terminal input target stands on (today's `lib/input-requests/ports.ts`, the part a terminal uses;
 * the rest is the Vault's). Nothing here has a place to put a value except the `text` {@link
 * TerminalInputTargetPort.type} is handed, which is the one write.
 */

export type { ProfileProgram, TypeOptions, TypeResult };
export type ObserveResult = VaultObserveResult;

/**
 * Whether a process runs a code program (`CODE_PROGRAMS`) from an executable this account cannot replace: decided from
 * the real file, never from the name `ps` shows (adapters/system/executable-code-programs.ts).
 */
export interface CodeProgramPort {
  codeProgram(pid: number): Promise<boolean>;
}

/** The program one process runs, as the kernel PROVES it (adapters/system/kernel-program-proof.ts). */
export interface ProvenProgram {
  /**
   * Its name: the entry in a root-controlled bin folder its executable is reached from, or, for a process running
   * setuid root, a getpass name it runs under. That second name is NOT proof of which setuid program it is: whoever
   * starts it picks it (a link's name on Linux, argv[0] on macOS). Only that root placed the program is proved.
   */
  readonly name: string;
  /** It runs setuid root right now: effective uid 0 while its real uid is not. A ferret cannot make one. */
  readonly setuidRoot: boolean;
}

/**
 * WHO CAN READ A TERMINAL. Every process of the TTY's foreground process group can read what is typed, and so can a
 * process of ANOTHER session that opened the TTY by its path (the pty belongs to this account). The name `ps` shows
 * is no proof of either: any process can rewrite its own (`printf sudo > /proc/$$/comm`).
 */
export interface ProgramProofPort {
  /** What the kernel proves about the program `pid` runs; `undefined` when anything is unproven or unreadable. */
  prove(pid: number): Promise<ProvenProgram | undefined>;
  /**
   * Whether a process whose controlling terminal is NOT `ttyPath` holds it open, so it could read from it outside job
   * control. `false` only when that was looked for and none was found; `undefined` when it cannot be told.
   */
  heldElsewhere(ttyPath: string): Promise<boolean | undefined>;
  /**
   * The program `pid` runs, proved ONLY through the owner's own Nix profile: `~/.nix-profile/bin/<name>` walks, through
   * the profile's own links and the store, to the very store file it runs. Any process running as the owner can swap
   * that program, so this proof earns nothing but what the owner allowed (secure-copy `allowProfileTargets`).
   */
  proveProfile?(pid: number): Promise<ProfileProgram | undefined>;
}

/**
 * A terminal's own adapter: one prompt, so one value, in ONE write of `text` with Enter appended when
 * `submit`, in a single command. `inputTargetAdapter` (daemon/index.ts) adapts it to Vault's `input.targets`.
 */
export interface TerminalInputTargetPort {
  observe(sessionId: string, target: InputTarget): Promise<ObserveResult>;
  type(
    sessionId: string,
    target: InputTarget,
    text: string,
    submit: boolean,
    expected: InputTargetFacts,
    options?: TypeOptions,
  ): Promise<TypeResult>;
}

/** Programs that ask for a password on the terminal through getpass (today's `lock.ts`). */
export const GETPASS_PROGRAMS: ReadonlySet<string> = new Set(['sudo', 'sudoedit', 'su', 'doas', 'passwd']);

/**
 * The programs whose echo-off prompt may be a one-time code: remote shells and cloud CLIs that ask for a 2FA code. A
 * bare shell's `read -s` is never one, whatever its line says. Matched against the REAL executable a process runs, and
 * only one this account cannot replace (`CodeProgramPort`): a name in `ps` can be rewritten or copied.
 */
export const CODE_PROGRAMS: ReadonlySet<string> = new Set([
  'ssh',
  'scp',
  'sftp',
  'mosh-client',
  'aws',
  'gcloud',
  'az',
  'vault',
]);
