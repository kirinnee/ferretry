import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { PosterAnswer } from '../../../contract/index.ts';
import { type PostPayload, type PullAddress, type PullsClient, readPoster } from './api.ts';
import { Composer } from './composer.tsx';
import { ComposeFrame, type ComposeValue } from './context.tsx';
import { type DiffRange, quoteOf, whereText, withQuote } from './quote.ts';

type Draft =
  | { readonly kind: 'comment'; readonly text: string }
  /** `commitId` is the head the lines were selected on: the comment is made against THAT commit, never a later one. */
  | { readonly kind: 'line'; readonly range: DiffRange; readonly commitId: string; readonly text: string };

/** What a line comment says when the PR moved under it. */
const STALE_LINES_SENTENCE =
  'This pull request has new commits since you picked these lines, so they may have moved. Close this and select the lines again.';

/**
 * The account a post goes out as (id and login), read once per PR and again when the daemon says it changed. `null`: the
 * project has no account to post as.
 */
function usePoster(client: PullsClient, address: PullAddress) {
  const [held, setHeld] = useState<{ readonly key: string; readonly poster: PosterAnswer | null } | undefined>(
    undefined,
  );
  const [again, setAgain] = useState(0);
  const key = JSON.stringify([address.project, address.owner, address.name, address.number]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `again` is read nowhere inside, on purpose: it asks for another read.
  useEffect(() => {
    let live = true;
    readPoster(client, address).then(
      answer => live && setHeld({ key, poster: answer }),
      () => live && setHeld({ key, poster: null }),
    );
    return () => {
      live = false;
    };
  }, [client, key, address, again]);
  const recheck = useCallback(() => setAgain(count => count + 1), []);
  return { poster: held?.key === key ? held.poster : undefined, recheck };
}

/**
 * Everything composing hangs off the PR page through this: it reads who a post goes out as, keeps the ONE open comment
 * draft (a PR comment, or a comment on diff lines) at the foot of the page, and hands the three ways text reaches it
 * (a quote, a diff range, a blank comment) to the parts that sit under it.
 */
export function ComposeDock({
  client,
  address,
  pullUrl,
  headSha,
  onChanged,
  children,
}: {
  readonly client: PullsClient;
  readonly address: PullAddress;
  readonly pullUrl: string;
  readonly headSha: string;
  readonly onChanged: () => void;
  readonly children: ReactNode;
}) {
  const { poster, recheck } = usePoster(client, address);
  const [threadsReload, setThreadsReload] = useState(0);
  const reloadThreads = useCallback(() => setThreadsReload(count => count + 1), []);
  const [draft, setDraft] = useState<Draft | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  const quote = useCallback((selected: string, range?: DiffRange) => {
    const text = quoteOf(selected, range);
    if (text === '') return;
    setNotice(undefined);
    setDraft(
      current =>
        ({
          ...(current ?? { kind: 'comment' as const }),
          text: withQuote(current?.text ?? '', text),
        }) as Draft,
    );
  }, []);
  const commentOnLines = useCallback(
    (range: DiffRange): boolean => {
      if (draft !== undefined && draft.text.trim() !== '') {
        setNotice('Finish or close the comment that is open first.');
        return false;
      }
      setNotice(undefined);
      setDraft({ kind: 'line', range, commitId: headSha, text: '' });
      return true;
    },
    [draft, headSha],
  );
  const stale = draft?.kind === 'line' && draft.commitId !== headSha;
  const openComment = useCallback(() => {
    setNotice(undefined);
    setDraft(current => current ?? { kind: 'comment', text: '' });
  }, []);

  const value = useMemo<ComposeValue>(
    () => ({
      client,
      address,
      pullUrl,
      headSha,
      poster,
      recheckPoster: recheck,
      changed: onChanged,
      reloadThreads,
      threadsReload,
      quote,
      commentOnLines,
      openComment,
    }),
    [
      client,
      address,
      pullUrl,
      headSha,
      poster,
      recheck,
      onChanged,
      reloadThreads,
      threadsReload,
      quote,
      commentOnLines,
      openComment,
    ],
  );
  const payload = useMemo<PostPayload | undefined>(
    () =>
      draft === undefined
        ? undefined
        : draft.kind === 'comment'
          ? { kind: 'comment' }
          : {
              kind: 'line',
              commitId: draft.commitId,
              path: draft.range.path,
              side: draft.range.side,
              line: draft.range.line,
              ...(draft.range.startLine < draft.range.line ? { startLine: draft.range.startLine } : {}),
            },
    [draft],
  );

  return (
    <ComposeFrame value={value}>
      {children}
      {notice !== undefined && (
        <p className="m-0 text-meta text-warn" data-compose-notice="" role="status">
          {notice}
        </p>
      )}
      {draft !== undefined && payload !== undefined && (
        <div className="sticky bottom-0 z-10 bg-bg pt-xs" data-compose-dock={draft.kind}>
          <Composer
            autoFocus
            blocked={stale ? STALE_LINES_SENTENCE : undefined}
            closeLabel={draft.text.trim() === '' ? 'Close' : 'Discard'}
            onChange={text => setDraft(current => (current === undefined ? current : { ...current, text }))}
            onClose={() => setDraft(undefined)}
            payload={payload}
            title={draft.kind === 'comment' ? 'Comment on this pull request' : `Comment on ${whereText(draft.range)}`}
            value={draft.text}
          />
        </div>
      )}
    </ComposeFrame>
  );
}
