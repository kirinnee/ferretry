import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { type PostPayload, type PullAddress, type PullsClient, readPoster } from './api.ts';
import { Composer } from './composer.tsx';
import { ComposeFrame, type ComposeValue } from './context.tsx';
import { type DiffRange, quoteOf, whereText, withQuote } from './quote.ts';

type Draft =
  | { readonly kind: 'comment'; readonly text: string }
  | { readonly kind: 'line'; readonly range: DiffRange; readonly text: string };

/** The login a post goes out as, read once per PR. `null`: the project has no account to post as. */
function usePoster(client: PullsClient, address: PullAddress): string | null | undefined {
  const [held, setHeld] = useState<{ readonly key: string; readonly login: string | null } | undefined>(undefined);
  const key = JSON.stringify([address.project, address.owner, address.name, address.number]);
  useEffect(() => {
    let live = true;
    readPoster(client, address).then(
      answer => live && setHeld({ key, login: answer.login }),
      () => live && setHeld({ key, login: null }),
    );
    return () => {
      live = false;
    };
  }, [client, key, address]);
  return held?.key === key ? held.login : undefined;
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
  const login = usePoster(client, address);
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
      setDraft({ kind: 'line', range, text: '' });
      return true;
    },
    [draft],
  );
  const openComment = useCallback(() => {
    setNotice(undefined);
    setDraft(current => current ?? { kind: 'comment', text: '' });
  }, []);

  const value = useMemo<ComposeValue>(
    () => ({ client, address, pullUrl, headSha, login, changed: onChanged, quote, commentOnLines, openComment }),
    [client, address, pullUrl, headSha, login, onChanged, quote, commentOnLines, openComment],
  );
  const payload = useMemo<PostPayload | undefined>(
    () =>
      draft === undefined
        ? undefined
        : draft.kind === 'comment'
          ? { kind: 'comment' }
          : {
              kind: 'line',
              commitId: headSha,
              path: draft.range.path,
              side: draft.range.side,
              line: draft.range.line,
              ...(draft.range.startLine < draft.range.line ? { startLine: draft.range.startLine } : {}),
            },
    [draft, headSha],
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
