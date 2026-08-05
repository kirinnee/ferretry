import type { SecretChildOutcome, SecretChildRunner, SecretChildSpec } from '../../lib/index.ts';

/**
 * The ONLY environment a use child inherits from this daemon, by name.
 *
 * AN ALLOWLIST, NOT A FILTER, and the reason is specific: this daemon loads its own configured
 * secrets file into its own environment at boot (`lib/runtime/secrets.ts`). A child that inherited
 * `process.env` wholesale would therefore receive every one of those values — secrets the caller
 * never asked for and the vault has no record of, so redaction would not even know to mask them.
 * Passing through only what a program needs to run makes that leak unrepresentable.
 *
 * `PATH` is here because without it a bare `curl` cannot be found; the rest are what ordinary tools
 * need to behave like themselves rather than like a program in an empty container.
 */
const INHERITED: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];

const ABANDONED = Symbol('abandoned');

interface CappedRead {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Reads at most `maxBytes` and stops the moment `abandoned` settles.
 *
 * The escape matters here for the same reason it does for Git: a grandchild inheriting the pipe
 * keeps the stream open after the child is killed, so a timed-out use would hold the daemon open
 * past its own deadline.
 */
async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abandoned: Promise<typeof ABANDONED>,
): Promise<CappedRead> {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  let abandonedRead = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abandoned]);
      if (result === ABANDONED) {
        abandonedRead = true;
        break;
      }
      if (result.done) break;
      const chunk = result.value;
      const remaining = maxBytes - keptBytes;
      const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      chunks.push(kept);
      keptBytes += kept.byteLength;
      truncated ||= kept.byteLength < chunk.byteLength;
    }
  } finally {
    if (abandonedRead) await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

/**
 * Spawns one child with the resolved secrets in ITS environment, and returns its raw output.
 *
 * NOTHING HERE QUOTES THE COMMAND OR THE ENVIRONMENT. A spawn failure reports that the spawn failed
 * and nothing about what was spawned: argv is written by the caller, and a caller that put a value
 * on the command line would otherwise have it handed straight back through the diagnostic path.
 * There is no `cause` chain on the refusal for the same reason.
 *
 * REDACTION IS NOT DONE HERE. Raw output crosses this boundary once, into the domain, which masks it
 * before anybody else sees it. Keeping the two apart means the scrubbing is unit-tested as pure
 * logic rather than only observable through a spawn.
 */
export class BunSecretChildRunner implements SecretChildRunner {
  constructor(private readonly inherited: () => Readonly<Record<string, string | undefined>> = () => process.env) {}

  async run(spec: SecretChildSpec): Promise<SecretChildOutcome> {
    const [program, ...rest] = spec.command;
    if (program === undefined) return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    const base = this.inherited();
    const environment: Record<string, string> = {};
    for (const key of INHERITED) {
      const value = base[key];
      if (value !== undefined) environment[key] = value;
    }

    let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    try {
      child = Bun.spawn([program, ...rest], {
        cwd: spec.cwd,
        env: { ...environment, ...spec.env },
        // Never inherited and never open: every use is non-interactive, and an open stdin with
        // nothing written can only hang the daemon on a prompt nobody will answer.
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch {
      return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    }

    let timedOut = false;
    const abandoned = Promise.withResolvers<typeof ABANDONED>();
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      abandoned.resolve(ABANDONED);
    }, spec.timeoutMs);

    try {
      const [exited, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, abandoned.promise]),
        readCapped(child.stdout, spec.maxOutputBytes, abandoned.promise),
        readCapped(child.stderr, spec.maxOutputBytes, abandoned.promise),
      ]);
      // A killed child has no exit status worth reporting: naming one would claim the program chose
      // to end that way, when in fact this daemon ended it.
      if (timedOut || exited === ABANDONED)
        return { outcome: 'timeout', stdout: stdout.text, stderr: stderr.text, truncated: true };
      return {
        outcome: 'exited',
        exitCode: exited,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
