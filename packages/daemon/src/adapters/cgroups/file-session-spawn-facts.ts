import type { SessionSpawnFacts, SessionSpawnFactsPort } from '../../lib/cgroups/index.ts';
import { createSessionPaths, type FileSystemPort, type FoundationPaths, tryParseSessionId } from '../../lib/index.ts';

/**
 * The two durable spawn facts a session's own document records, read straight from that document.
 *
 * WHY THE DOCUMENT AND NOT THE INDEX. This reader is used on the launch path, which runs before the
 * process has any storage handle to consult and while the session directory has just been written.
 * The document is the record itself; the index is a projection of it. Reading the source keeps one
 * fact with one owner and removes an ordering constraint that would otherwise exist for no benefit.
 *
 * ABSENT, UNREADABLE OR NOT AN OBJECT ALL ANSWER `undefined`, and the two callers resolve that in
 * opposite, deliberate directions — see `lib/cgroups/exemption.ts`. A malformed `label`, `parent` or
 * `wardenLineage` is dropped rather than coerced: a number where a boolean belongs is not evidence
 * of descent, and treating it as one would shield a session on the strength of damage.
 *
 * WHICH OF THE THREE PRODUCTION ACTUALLY WRITES: `label` and `parent` — both are set on the start
 * envelope this daemon persists, and the compiled journey reads a real `"label":"fleet-warden"` back
 * out of one. `wardenLineage` is read for the day it exists and is never written today; that gap,
 * and why the `parent` walk is therefore load-bearing rather than a nicety, is stated in
 * `lib/cgroups/exemption.ts`.
 */
export class FileSessionSpawnFacts implements SessionSpawnFactsPort {
  constructor(
    private readonly files: FileSystemPort,
    private readonly paths: FoundationPaths,
  ) {}

  async facts(sessionId: string): Promise<SessionSpawnFacts | undefined> {
    const parsed = tryParseSessionId(sessionId);
    if (parsed === undefined) return undefined;
    const raw = await this.files.readText(createSessionPaths(this.paths, parsed).config).catch(() => undefined);
    if (raw === undefined) return undefined;
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) return undefined;
    const value = document as Readonly<Record<string, unknown>>;
    return {
      ...(typeof value.label === 'string' ? { label: value.label } : {}),
      ...(typeof value.parent === 'string' ? { parent: value.parent } : {}),
      ...(typeof value.wardenLineage === 'boolean' ? { wardenLineage: value.wardenLineage } : {}),
    };
  }
}
