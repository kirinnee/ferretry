import type { Placement } from './place.ts';
import { ThreadCard } from './thread-card.tsx';

/**
 * The threads that are not on a diff row: those GitHub marks outdated (their line is gone from the current diff) and
 * those whose line is not on a row drawn here. They are listed with their file and line, never placed on a guess.
 */
export function OutdatedThreads({ placement }: { readonly placement: Placement }) {
  const { outdated, elsewhere } = placement;
  if (outdated.length === 0 && elsewhere.length === 0) return null;
  return (
    <section className="grid gap-sm" aria-label="Threads not on the diff" data-outdated-threads="">
      {outdated.length > 0 && (
        <div className="grid gap-xs" data-outdated-group="outdated">
          <h3 className="m-0 text-label font-semibold uppercase tracking-label text-faint">
            Outdated ({outdated.length})
          </h3>
          {outdated.map(thread => (
            <ThreadCard key={thread.id} thread={thread} showPath />
          ))}
        </div>
      )}
      {elsewhere.length > 0 && (
        <div className="grid gap-xs" data-outdated-group="elsewhere">
          <h3 className="m-0 text-label font-semibold uppercase tracking-label text-faint">
            Not on a line shown here ({elsewhere.length})
          </h3>
          {elsewhere.map(thread => (
            <ThreadCard key={thread.id} thread={thread} showPath />
          ))}
        </div>
      )}
    </section>
  );
}
