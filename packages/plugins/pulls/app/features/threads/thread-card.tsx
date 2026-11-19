import type { PullComment, ReviewThread } from '../../../contract/index.ts';
import { safeGithubUrl } from './place.ts';

/** The device's local time (the owner reads local time everywhere on these screens). */
const localTime = (iso: string): string => new Date(iso).toLocaleString();

function Comment({ comment }: { readonly comment: PullComment }) {
  const link = safeGithubUrl(comment.url);
  return (
    <li
      className="m-0 grid gap-1 border-t border-border-strong py-sm first:border-t-0"
      data-thread-comment={comment.id}
    >
      <div className="flex flex-wrap items-baseline gap-x-sm text-meta text-fg-soft">
        {/* A login is text, not a link: nothing a stranger wrote becomes navigation. */}
        <strong className="font-semibold text-fg">{comment.author.login}</strong>
        <time dateTime={comment.createdAt}>{localTime(comment.createdAt)}</time>
        {link !== undefined && (
          <a href={link} target="_blank" rel="noopener noreferrer" className="text-accent underline">
            Open on GitHub
          </a>
        )}
      </div>
      {/* A stranger's text, shown as text only: no HTML, no Markdown, no reference links, no images. */}
      <p className="m-0 whitespace-pre-wrap break-words text-body text-fg">{comment.body}</p>
    </li>
  );
}

/** Where a thread was made: `path:line`, with the range and the side when they say something. */
export function threadWhere(thread: ReviewThread): string {
  const range =
    thread.line === undefined
      ? ''
      : thread.startLine !== undefined && thread.startLine < thread.line
        ? `:${thread.startLine}-${thread.line}`
        : `:${thread.line}`;
  return `${thread.path}${range}`;
}

/**
 * One review thread. An open thread shows its comments; a resolved one is collapsed to one line (a native `<details>`, so
 * opening it is not a re-render). `showPath` is for a list, where the thread is not already under its own file.
 */
export function ThreadCard({
  thread,
  showPath = false,
}: {
  readonly thread: ReviewThread;
  readonly showPath?: boolean;
}) {
  const count = thread.comments.length;
  const label = `${count} ${count === 1 ? 'comment' : 'comments'}`;
  return (
    <details
      open={!thread.resolved}
      className="rounded-md border border-border-strong bg-surface-2"
      data-thread={thread.id}
      data-resolved={thread.resolved ? 'true' : 'false'}
      data-side={thread.side}
    >
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-sm px-sm py-xs text-meta text-fg-soft">
        {thread.resolved ? (
          <span className="font-semibold text-ok">Resolved</span>
        ) : (
          <span className="font-semibold">Open</span>
        )}
        <span>{label}</span>
        {thread.side === 'left' && <span>on the old side</span>}
        {showPath && <span className="mono break-all">{threadWhere(thread)}</span>}
      </summary>
      <ul className="m-0 list-none px-sm pb-xs">
        {thread.comments.map(comment => (
          <Comment key={comment.id} comment={comment} />
        ))}
      </ul>
    </details>
  );
}
