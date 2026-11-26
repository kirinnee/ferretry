import type { FencedPath, FerretId, KernelPorts } from '@ferretry/kernel/contract';
import type { BoundTranscriptReader, FoundConversation, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import { instantFromEpochMs, milliseconds, seconds, type Instant, type JsonValue } from '@ferretry/std';
import { OPENCODE_SESSIONS } from '../../contract/index.ts';
import { isolatedEnvironment } from '../lib/environment.ts';
import { exportReader } from '../lib/export-reader.ts';
import { decodeExport, exportUsage } from '../lib/session-export.ts';

const scrub = (value: JsonValue, mask: (text: string) => string): JsonValue => {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(item => scrub(item, mask));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, mask)]));
  return value;
};

export function sessionStore(
  kernel: Pick<KernelPorts, 'spawn' | 'state' | 'clock' | 'redaction'>,
  homeFor: (ferret: FerretId) => Promise<FencedPath>,
  locate: () => Promise<string | undefined>,
) {
  const readers = new Map<FerretId, BoundTranscriptReader>();
  const binding = async (ferret: FerretId) => {
    const found = await kernel.state.read(OPENCODE_SESSIONS, ferret);
    if (!found.ok || found.value === undefined) throw new Error('OpenCode has no proved session for this ferret');
    return found.value.session;
  };
  const snapshot = async (ferret: FerretId, session?: string) => {
    const id = session ?? (await binding(ferret));
    if (!/^ses_[A-Za-z0-9_-]{1,160}$/u.test(id)) throw new Error('OpenCode needs a valid session ID');
    const binary = await locate();
    if (binary === undefined) throw new Error('OpenCode V2 could not be found');
    const home = await homeFor(ferret);
    const output = await kernel.spawn.runBytes(binary, ['session', 'export', id, '--standalone'], {
      env: isolatedEnvironment(home),
      cwd: home,
      sealed: true,
      timeout: seconds(15),
      maxStdoutBytes: 64 * 1024 * 1024,
      maxStderrBytes: 1024,
    });
    if (output.exitCode !== 0 || output.timedOut || output.stdoutTruncated)
      throw new Error('The OpenCode session export could not be read completely');
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output.stdout));
    } catch {
      throw new Error('OpenCode did not return a complete JSON session export');
    }
    return decodeExport(raw, id);
  };
  const mask = async (entry: TranscriptEntry): Promise<TranscriptEntry> =>
    kernel.redaction.read(scope => ({
      ...entry,
      ...(entry.text === undefined ? {} : { text: scope.text(entry.text) }),
      ...(entry.data === undefined ? {} : { data: scrub(entry.data, text => scope.text(text)) }),
    }));
  const reader = (ferret: FerretId): BoundTranscriptReader => {
    let found = readers.get(ferret);
    if (found === undefined) {
      found = exportReader({
        snapshot: () => snapshot(ferret),
        mask,
        nowMs: () => kernel.clock.nowMs(),
        // read-scoped: none — sleeps on the clock; reads no text
        wait: (ms, signal) => kernel.clock.sleep(milliseconds(ms), signal),
      });
      readers.set(ferret, found);
    }
    return found;
  };
  return {
    snapshot,
    async bind(ferret: FerretId, session: string) {
      readers.delete(ferret);
      await kernel.state.write(OPENCODE_SESSIONS, { format: 1, session }, ferret);
    },
    forget: (ferret: FerretId) => {
      readers.delete(ferret);
    },
    transcript: {
      read: async (ferret: FerretId, after?: string, limit?: number) => reader(ferret).read(after, limit),
      find: async (ferret: FerretId, id: string) => reader(ferret).find(id),
      follow: (ferret: FerretId, signal: AbortSignal) => reader(ferret).follow(signal),
    },
    usage: {
      async turns(ferret: FerretId, since?: Instant) {
        const usage = exportUsage(await snapshot(ferret));
        return usage.turns.filter(turn => since === undefined || turn.at >= since);
      },
    },
    conversations: {
      async list(folder?: FencedPath): Promise<readonly FoundConversation[]> {
        const found: FoundConversation[] = [];
        // Only bindings in this plugin's own state; never inspect the owner's OpenCode database.
        for (const name of await kernel.state.list(OPENCODE_SESSIONS)) {
          try {
            const { info } = await snapshot(name as FerretId);
            if (folder !== undefined && info.location.directory !== folder) continue;
            found.push(
              await kernel.redaction.read(scope => ({
                id: info.id,
                folder: scope.text(info.location.directory),
                ...(info.title === undefined ? {} : { title: scope.text(info.title) }),
                updatedAt: instantFromEpochMs(info.time.updated ?? info.time.created),
              })),
            );
          } catch {
            /* An unreadable private session is never guessed from recency or from a different home. */
          }
        }
        return found;
      },
    },
  };
}
