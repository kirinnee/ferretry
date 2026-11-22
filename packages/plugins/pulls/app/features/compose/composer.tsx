import { Button, ExternalLink } from '@ferretry/app/ui';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { MAX_POST_BODY, SECRET_SHAPED_SENTENCE } from '../../../contract/index.ts';
import { SafeProse } from '../pr-page/safe-prose.tsx';
import { safeGithubUrl } from '../threads/place.ts';
import type { PostPayload } from './api.ts';
import { useCompose } from './context.tsx';
import { usePost } from './use-post.ts';

/** How near the cap the counter starts to speak up. */
const NEAR = 0.9;

/**
 * Write a comment, see it as GitHub will draw it, and post it as the connected account. The words on the button name the
 * account, always. Text goes into the box as plain text; the preview draws it through the PR page's own inert renderer.
 * Nothing here can attach a file: GitHub's API takes text only, and the box says so.
 */
export function Composer({
  payload,
  value,
  onChange,
  title,
  autoFocus = false,
  onPosted,
  onClose,
  closeLabel = 'Close',
  blocked,
}: {
  readonly payload: PostPayload;
  readonly value: string;
  readonly onChange: (next: string) => void;
  /** The heading: what this comment is on. */
  readonly title: string;
  readonly autoFocus?: boolean;
  /** The post is on GitHub (the draft has been cleared). */
  readonly onPosted?: () => void;
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  /** Why this cannot be posted as it stands (the lines were picked on an older commit): said, and the button is off. */
  readonly blocked?: string | undefined;
}) {
  const { client, address, poster, recheckPoster, pullUrl, changed, reloadThreads } = useCompose();
  const login = poster === undefined || poster === null ? poster : poster.login;
  const [preview, setPreview] = useState(false);
  const { phase, post, postAgain, check, clear } = usePost(client, address, payload, poster, {
    onChanged: changed,
    onThreadsChanged: reloadThreads,
    onAccountChanged: recheckPoster,
    onPosted: () => {
      onChange('');
      // The next thing to see is the empty box to write in, not an empty preview.
      setPreview(false);
      onPosted?.();
    },
  });
  const box = useRef<HTMLTextAreaElement>(null);
  // Opened by a person's press, so the box takes the cursor: they came here to type.
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);
  // Only an https://github.com address is ever a link (the same check every other link here goes through).
  const source = safeGithubUrl(pullUrl) ?? 'https://github.com/';
  const length = value.length;
  const over = length > MAX_POST_BODY;
  const blank = value.trim() === '';
  const busy = phase.status === 'posting';
  const ready = login !== undefined && login !== null && !blank && !over && !busy && blocked === undefined;
  const posted = phase.status === 'posted' ? safeGithubUrl(phase.answer.url ?? '') : undefined;

  const change = (next: string): void => {
    // Typing after a result is a new comment: the old result is not left on screen over it.
    if (phase.status === 'posted' || phase.status === 'failed' || phase.status === 'secret') clear();
    onChange(next);
  };

  return (
    <section
      aria-label={title}
      className="kt-panel grid gap-xs p-panel font-ui"
      data-compose=""
      data-compose-kind={payload.kind}
    >
      <header className="flex flex-wrap items-center justify-between gap-sm">
        <h3 className="m-0 min-w-0 break-words text-ui font-semibold text-fg">
          <bdi>{title}</bdi>
        </h3>
        <span className="flex items-center gap-xs">
          {/* The kit's own tab look (`kt-tab`): the one showing has the neutral fill, nothing else changes. */}
          <button aria-pressed={!preview} className="kt-tab" onClick={() => setPreview(false)} type="button">
            Write
          </button>
          <button aria-pressed={preview} className="kt-tab" onClick={() => setPreview(true)} type="button">
            Preview
          </button>
          {onClose !== undefined && (
            <Button onClick={onClose} size="sm" type="button" variant="ghost">
              {closeLabel}
            </Button>
          )}
        </span>
      </header>
      {preview ? (
        <div className="min-h-[7.5rem] rounded-control border border-border-soft p-sm" data-compose-preview="">
          {blank ? (
            <p className="m-0 text-meta text-faint">Nothing to preview yet.</p>
          ) : (
            <SafeProse sourceUrl={source} text={value} />
          )}
        </div>
      ) : (
        <textarea
          aria-label={title}
          className="kt-input min-h-[7.5rem] resize-y"
          data-compose-box=""
          dir="auto"
          onChange={event => change(event.target.value)}
          ref={box}
          rows={5}
          value={value}
        />
      )}
      <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-sm text-meta text-muted">
        <span>Text only: GitHub's API cannot take images or files from here.</span>
        <span
          className={over ? 'text-err' : length >= MAX_POST_BODY * NEAR ? 'text-warn' : 'text-faint'}
          data-compose-count={length}
        >
          {length.toLocaleString('en-US')} / {MAX_POST_BODY.toLocaleString('en-US')}
        </span>
      </p>
      {phase.status === 'secret' && (
        <div
          className="grid gap-xs rounded-control border-2 border-warn bg-warn/10 p-sm text-ui text-fg"
          data-compose-secret=""
          role="alert"
        >
          <p className="m-0 flex items-start gap-xs font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0 text-warn" size={16} />
            <span>{phase.message === '' ? SECRET_SHAPED_SENTENCE : phase.message}</span>
          </p>
          <span className="flex flex-wrap gap-xs">
            <Button onClick={() => box.current?.focus()} size="sm" type="button">
              Edit the text
            </Button>
            <Button
              disabled={blocked !== undefined}
              onClick={() => void post(value, true)}
              size="sm"
              type="button"
              variant="danger"
            >
              Post anyway
            </Button>
          </span>
        </div>
      )}
      {phase.status === 'unknown' && (
        <div
          className="grid gap-xs rounded-control border-2 border-warn bg-warn/10 p-sm text-ui text-fg"
          data-compose-unknown=""
          role="status"
        >
          <p className="m-0 flex items-start gap-xs font-semibold">
            <TriangleAlert aria-hidden="true" className="mt-0.5 shrink-0 text-warn" size={16} />
            <span>
              {phase.check === 'reading'
                ? 'Not sure this was posted: GitHub did not answer. Reading the thread again to see…'
                : phase.check === 'read'
                  ? 'Not sure this was posted: GitHub did not answer. The thread has been read again; if your comment is not there, post it again.'
                  : 'Not sure this was posted: GitHub did not answer, and the thread could not be read again. Look on GitHub, or read it again.'}
            </span>
          </p>
          <span className="flex flex-wrap gap-xs">
            {phase.check === 'read' && (
              <Button disabled={blocked !== undefined} onClick={postAgain} size="sm" type="button">
                It is not there: post again
              </Button>
            )}
            {phase.check === 'unread' && (
              <Button onClick={() => void check()} size="sm" type="button">
                Read the thread again
              </Button>
            )}
          </span>
        </div>
      )}
      {blocked !== undefined && (
        <p className="m-0 text-meta text-warn" data-compose-stale="" role="status">
          {blocked}
        </p>
      )}
      {/* One line is always kept for the result, so a post's answer does not push the button away. */}
      <div aria-live="polite" className="min-h-5 text-meta">
        {phase.status === 'failed' && (
          <p className="m-0 text-err" data-compose-failed="" role="alert">
            {phase.message}
          </p>
        )}
        {phase.status === 'posted' && (
          <p className="m-0 font-semibold text-ok" data-compose-posted={phase.answer.id}>
            Posted{phase.answer.replayed ? ' (this was already posted)' : ''}.{' '}
            {posted !== undefined && <ExternalLink href={posted}>Open on GitHub</ExternalLink>}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span className="min-w-0 text-meta text-muted" data-compose-as="">
          {login === null ? (
            'No GitHub account is linked to this project.'
          ) : login === undefined ? (
            'Checking which account this posts as…'
          ) : (
            // Readable whatever the button looks like: a button with nothing to post yet is drawn flat.
            <>
              Posts as @<bdi>{login}</bdi>
            </>
          )}
        </span>
        <Button disabled={!ready} onClick={() => void post(value)} size="sm" type="button" variant="primary">
          {login === undefined || login === null ? (
            'Post'
          ) : (
            // One element: a button lays its children out in a row, which would split the words from the name.
            <span>
              Post as @<bdi>{login}</bdi>
            </span>
          )}
        </Button>
      </div>
    </section>
  );
}
