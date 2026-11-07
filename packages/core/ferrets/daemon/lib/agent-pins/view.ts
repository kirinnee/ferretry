import type { SessionView } from '@ferretry/protocol';
import type { SessionDirectorySubsystem } from '../runtime/mounts/sessions.ts';
import { createViewMemo } from '../session/directory/view-memo.ts';
import type { AgentPinService } from './service.ts';

/**
 * Puts `pinnedAt` on the views of the ferrets the owner pinned, and leaves every other view as it is.
 *
 * It wraps the session reader at the mount, like the other derived marks, so the pin rides the polled
 * `GET /v1/sessions` to every device the owner has open without a request of its own. A pin list that
 * cannot be read is "nothing pinned": the mark is a preference, and a roster that fails to load because
 * of it would be the worse defect.
 */
export function withPinned(
  reader: SessionDirectorySubsystem,
  pins: Pick<AgentPinService, 'pinnedAt'>,
): SessionDirectorySubsystem {
  const memo = createViewMemo<string>();
  const mark = (view: SessionView, pinned: ReadonlyMap<string, string>): SessionView => {
    const pinnedAt = pinned.get(view.config.id);
    return pinnedAt === undefined ? view : memo(view, pinnedAt, () => ({ ...view, pinnedAt }));
  };
  const pinned = async (): Promise<ReadonlyMap<string, string>> =>
    await pins.pinnedAt().catch((): ReadonlyMap<string, string> => new Map());
  return {
    list: async () => {
      const [views, marks] = await Promise.all([reader.list(), pinned()]);
      return views.map(view => mark(view, marks));
    },
    get: async reference => {
      const [view, marks] = await Promise.all([reader.get(reference), pinned()]);
      return view === undefined ? undefined : mark(view, marks);
    },
  };
}
