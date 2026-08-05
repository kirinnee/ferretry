import type { ISecretOutput } from '../../lib/secrets/ports.ts';

/** The narrow slice of the shipped terminal adapter this one composes over. */
export interface SecretConsole {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

export interface RawWriter {
  write(text: string): void;
}

/**
 * The secret commands' output.
 *
 * `raw` exists because `use` RELAYS a child's own streams. They must arrive byte-for-byte and
 * uncoloured — an agent piping `fy secret use -- curl …` into `jq` has to get exactly what `curl`
 * wrote, minus any masked value — so they bypass the coloured, newline-appending success path that
 * every other command uses.
 */
export class SecretConsoleOutput implements ISecretOutput {
  constructor(
    private readonly console: SecretConsole,
    private readonly stdout: RawWriter = { write: text => void process.stdout.write(text) },
    private readonly stderr: RawWriter = { write: text => void process.stderr.write(text) },
  ) {}

  success(message: string): void {
    this.console.success(message);
  }

  error(message: string): void {
    this.console.error(message);
  }

  setExitCode(code: number): void {
    this.console.setExitCode(code);
  }

  raw(stream: 'stdout' | 'stderr', text: string): void {
    (stream === 'stdout' ? this.stdout : this.stderr).write(text);
  }
}
