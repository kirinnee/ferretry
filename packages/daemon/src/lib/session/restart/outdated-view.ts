import { DORMANT_AGENT_STATUSES, type LaunchInstructionSectionId, type SessionView } from '@ferretry/protocol';
import type { SessionDirectorySubsystem } from '../../runtime/mounts/sessions.ts';

/**
 * Puts `outdated: { sections }` on the session views that are out of date, and leaves every other view as it is.
 *
 * It wraps the session reader at the mount rather than living inside it, because working out what a launch
 * would say now reads the ferret's launch environment — which itself reads the session — and the reader cannot
 * be allowed to call itself. The answers are kept for `ttlMs`: a list renders every ferret, a launch renders the
 * instructions, and nothing about a ferret's instructions changes faster than a person can look.
 *
 * A failure to work it out is "not outdated" — the mark is advice, and a roster that fails to load because of
 * it would be a worse defect than a mark that is missing.
 */

export interface OutdatedViewPorts {
  /** The sections a launch now would change for this ferret. */
  readonly outdated: (id: string) => Promise<readonly LaunchInstructionSectionId[]>;
  readonly now: () => number;
  readonly ttlMs: number;
}

export function withOutdated(reader: SessionDirectorySubsystem, ports: OutdatedViewPorts): SessionDirectorySubsystem {
  const answers = new Map<string, { readonly at: number; readonly sections: readonly LaunchInstructionSectionId[] }>();
  const sectionsOf = async (id: string): Promise<readonly LaunchInstructionSectionId[]> => {
    const known = answers.get(id);
    if (known !== undefined && ports.now() - known.at < ports.ttlMs) return known.sections;
    const sections = await ports.outdated(id).catch((): readonly LaunchInstructionSectionId[] => []);
    answers.set(id, { at: ports.now(), sections });
    return sections;
  };
  const mark = async (view: SessionView): Promise<SessionView> => {
    if (DORMANT_AGENT_STATUSES.has(view.state.status)) return view;
    const sections = await sectionsOf(view.config.id);
    return sections.length === 0 ? view : { ...view, outdated: { sections: [...sections] } };
  };
  return {
    list: async () => await Promise.all((await reader.list()).map(mark)),
    get: async reference => {
      const view = await reader.get(reference);
      return view === undefined ? undefined : await mark(view);
    },
  };
}
