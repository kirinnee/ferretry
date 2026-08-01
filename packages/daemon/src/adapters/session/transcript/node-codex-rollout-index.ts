import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  CodexRolloutBaseline,
  CodexRolloutCandidate,
  CodexRolloutIndex,
} from '../../../lib/session/transcript/index.ts';

/**
 * The rollouts a Codex home holds, and which of them carry a caller's correlation token.
 *
 * Codex writes one JSONL rollout per session under `<CODEX_HOME>/sessions/`, in date-partitioned
 * directories, and names it itself. The daemon therefore reads two things from each file: the id
 * from its `session_meta` header, and whether the bytes contain the token that proves ownership.
 *
 * EVERY READ IS WINDOWED. A rollout grows without bound while its agent works, and this index is
 * walked once per unresolved session, so reading whole files would make discovery cost proportional
 * to the fleet's total transcript volume. The header is in the first few lines by construction, and
 * the correlation token — the session's own directory, which its opening turn names — appears in
 * the first turn. A tail window is read as well, because a session that compacted may have pushed
 * the opening turn out of the head window but re-states its brief later.
 *
 * NOTHING HERE RANKS OR CHOOSES. It reports what each file is; `selectCodexRollout` decides, and
 * refuses when the evidence does not single one out.
 */

/** The header window: `session_meta` is the first record Codex writes. */
const HEAD_BYTES = 32 * 1024;
/** The tail window, for a rollout whose opening turn has scrolled out of the head. */
const TAIL_BYTES = 256 * 1024;
/** A walk bound, so a home with a pathological number of rollouts cannot stall a discovery. */
const MAX_ROLLOUTS = 4_000;

interface RolloutMeta {
  readonly id?: string;
  readonly cwd?: string;
}

/** The uuid Codex names a rollout file after, when the header did not answer. */
function idFromFilename(file: string): string | undefined {
  return /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/iu.exec(basename(file))?.[1];
}

function metaFromHead(head: string): RolloutMeta {
  for (const line of head.split('\n').slice(0, 8)) {
    if (line.trim() === '') continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: RolloutMeta };
      if (event.type === 'session_meta' && event.payload !== undefined) return event.payload;
      if (typeof event.payload?.id === 'string') return event.payload;
    } catch {
      // A partially flushed first line is normal on a live rollout; the filename still names it.
    }
  }
  return {};
}

export class NodeCodexRolloutIndex implements CodexRolloutIndex, CodexRolloutBaseline {
  /** Every rollout id this home already holds — the baseline a start records before launching. */
  async ids(home: string): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const file of await this.files(home)) {
      const id = await this.identify(file);
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  async candidates(home: string, correlationToken: string): Promise<readonly CodexRolloutCandidate[]> {
    const candidates: CodexRolloutCandidate[] = [];
    for (const file of await this.files(home)) {
      const id = await this.identify(file);
      if (id === undefined) continue;
      candidates.push({ id, file, correlated: await this.contains(file, correlationToken) });
    }
    return candidates;
  }

  /** Every `.jsonl` beneath `<home>/sessions`, bounded. */
  private async files(home: string): Promise<readonly string[]> {
    const found: string[] = [];
    const pending = [join(home, 'sessions')];
    while (pending.length > 0 && found.length < MAX_ROLLOUTS) {
      const directory = pending.shift() as string;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const child = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(child);
      }
    }
    return found;
  }

  private async identify(file: string): Promise<string | undefined> {
    const head = await this.window(file, 0, HEAD_BYTES);
    return metaFromHead(head ?? '').id ?? idFromFilename(file);
  }

  /** Whether the rollout's head or tail contains the token. */
  private async contains(file: string, needle: string): Promise<boolean> {
    const head = await this.window(file, 0, HEAD_BYTES);
    if (head?.includes(needle) === true) return true;
    const size = await stat(file)
      .then(info => info.size)
      .catch(() => 0);
    if (size <= HEAD_BYTES) return false;
    const tail = await this.window(file, Math.max(HEAD_BYTES, size - TAIL_BYTES), TAIL_BYTES);
    return tail?.includes(needle) === true;
  }

  /**
   * `length` bytes from `offset`, or nothing when the file is gone.
   *
   * A rollout that disappears between the walk and the read is ordinary — the harness rotates and
   * removes them — so an open that fails is absence rather than an error. A read that fails after a
   * successful open is NOT absence, and it is left to propagate: the resolver's caller degrades a
   * failed transcript read to an empty tail, and swallowing it here would instead report the file
   * as "present and containing nothing", which is a claim the daemon has not earned.
   */
  private async window(file: string, offset: number, length: number): Promise<string | undefined> {
    const handle = await open(file, 'r').catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
}
