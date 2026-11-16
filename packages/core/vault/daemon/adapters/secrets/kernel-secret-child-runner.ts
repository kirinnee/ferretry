import type { Clock, FencedPath, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import {
  NO_PROGRAM_LOCATOR,
  type ProgramLocator,
  type SecretChildOutcome,
  type SecretChildRunner,
  type SecretChildSpec,
} from '../../lib/secrets/types.ts';

/**
 * Spawns one child with the resolved secrets in ITS environment, and returns its raw output (today's
 * `BunSecretChildRunner`, copied; the spawn is the kernel's and the timer the kernel clock's).
 *
 * THE ENVIRONMENT IS A HANDLE. The runner never sees a value: `spec.env` is the Vault's opaque `ChildEnvironment`,
 * and the kernel's spawn adapter opens it at exec time (lead decision 9). What the child inherits besides it is only
 * what the kernel host names (today's `INHERITED` allowlist moved into the host's `childEnv`).
 *
 * NOTHING HERE QUOTES THE COMMAND OR THE ENVIRONMENT. A spawn failure reports that the spawn failed and nothing about
 * what was spawned: argv is written by the caller, and a caller that put a value on the command line would otherwise
 * have it handed straight back through the diagnostic path. There is no `cause` chain on the refusal for the same reason.
 *
 * REDACTION IS NOT DONE HERE. Raw output crosses this boundary once, into the domain, which masks it before anybody
 * else sees it.
 *
 * PROGRAM FACTS ARE A SEAM. Today's runner found the program on the child's PATH (`Bun.which`, `realpath`) and named
 * the file that ran and whether this account could replace it. The kernel's spawn port has no lookup, so that is a
 * {@link ProgramLocator} here; the default names nothing and the outcome carries neither fact (a declared parity gap).
 */
export class KernelSecretChildRunner implements SecretChildRunner {
  constructor(
    private readonly spawn: SpawnPort,
    private readonly clock: Clock,
    private readonly locator: ProgramLocator = NO_PROGRAM_LOCATOR,
    /**
     * A SEALED runner (a secure copy's command capture): every child it starts is `sealed`, so it inherits only the host's
     * sealed allowlist and never the git/gh tool overlay, whatever the executable is called. Its stdout is a value no
     * redaction can know yet, so nothing of the daemon's own environment may reach it.
     */
    private readonly sealed: boolean = false,
  ) {}

  async run(spec: SecretChildSpec): Promise<SecretChildOutcome> {
    const [program, ...rest] = spec.command;
    if (program === undefined) return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    let ran: { readonly program?: string; readonly replaceable?: true };
    try {
      const found = await this.locator.locate(program, spec.cwd, spec.path);
      ran = found === undefined ? {} : { program: found.program, ...(found.replaceable ? { replaceable: true } : {}) };
    } catch {
      return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    }
    let child: ReturnType<SpawnPort['start']>;
    try {
      // The route already refused a relative directory (`invalid_cwd`); the use runs where the caller named, as
      // today. The kernel's fence types it; this is the one place a use's own directory becomes that type.
      child = this.spawn.start(ran.program ?? program, rest, {
        cwd: spec.cwd as FencedPath,
        env: spec.env,
        ...(this.sealed ? { sealed: true as const } : {}),
        // Never an open stdin: every use is non-interactive, and an open stdin with nothing written can only hang
        // the daemon on a prompt nobody will answer. An empty write closes it.
        stdin: '',
      });
    } catch {
      return { outcome: 'spawn_failed', stdout: '', stderr: '', truncated: false };
    }

    let timedOut = false;
    const abandoned = Promise.withResolvers<typeof ABANDONED>();
    const cancel = this.clock.after(milliseconds(spec.timeoutMs), () => {
      timedOut = true;
      child.kill('SIGKILL');
      abandoned.resolve(ABANDONED);
    });

    try {
      const [exited, stdout, stderr] = await Promise.all([
        Promise.race([child.exited, abandoned.promise]),
        readCapped(child.stdout, spec.maxOutputBytes, abandoned.promise),
        readCapped(child.stderr, spec.maxOutputBytes, abandoned.promise),
      ]);
      // A killed child has no exit status worth reporting: naming one would claim the program chose to end that way.
      if (timedOut || exited === ABANDONED)
        return { outcome: 'timeout', ...ran, stdout: stdout.text, stderr: stderr.text, truncated: true };
      return {
        outcome: 'exited',
        ...ran,
        ...(exited === null ? {} : { exitCode: exited }),
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
      };
    } finally {
      cancel();
    }
  }
}

const ABANDONED = Symbol('abandoned');

interface CappedRead {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Reads at most `maxBytes` and stops the moment `abandoned` settles.
 *
 * The escape matters: a grandchild inheriting the pipe keeps the stream open after the child is killed, so a
 * timed-out use would hold the daemon open past its own deadline.
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
