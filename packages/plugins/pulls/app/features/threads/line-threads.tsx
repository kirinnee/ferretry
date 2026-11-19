import type { ReviewThread } from '../../../contract/index.ts';
import { type DiffSide, type Placement, threadsAt } from './place.ts';
import { ThreadCard } from './thread-card.tsx';

/**
 * The threads under one diff row. E5's diff viewer calls this where it draws a row (`path`, `side`, `line`); it draws
 * nothing for a row with no thread, so a plain row costs nothing and nothing appears after the first paint.
 */
export function LineThreads({
  placement,
  path,
  side,
  line,
}: {
  readonly placement: Placement;
  readonly path: string;
  readonly side: DiffSide;
  readonly line: number;
}) {
  const here: readonly ReviewThread[] = threadsAt(placement, path, side, line);
  if (here.length === 0) return null;
  return (
    <div className="grid gap-sm px-sm py-xs" data-line-threads={`${path}:${side}:${line}`}>
      {here.map(thread => (
        <ThreadCard key={thread.id} thread={thread} />
      ))}
    </div>
  );
}
