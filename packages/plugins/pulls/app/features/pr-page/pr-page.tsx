import { Loading, UnderlineTabs } from '@ferretry/app/ui';
import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { budgetSentence, type PullPage } from '../../../contract/index.ts';
import { type PullAddress, type PullsClient, readPullPage, reasonOf } from '../../lib/client.ts';
import { projectPagePath } from '../../lib/paths.ts';
import { CiTab } from './ci-tab.tsx';
import { Conversation } from './conversation.tsx';
import { FilesTab } from './files-tab.tsx';
import { localTime } from './format.ts';
import { PullHeader } from './header.tsx';

type TabId = 'conversation' | 'files' | 'ci';

/** What the page knows: nothing yet, a page (maybe stale after a failed refresh), a pause, or why it could not read. */
type Reading =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'paused'; readonly until: string; readonly page?: PullPage }
  | { readonly status: 'ready'; readonly page: PullPage; readonly stale?: string };

/** Reads the page, and again when asked. A failed refresh keeps the page it had and says so. */
function useReading(client: PullsClient, address: PullAddress): { reading: Reading; refresh: () => void } {
  const [reading, setReading] = useState<Reading>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const { project, owner, name, number } = address;
  useEffect(() => {
    let live = true;
    void tick;
    readPullPage(client, { project, owner, name, number }).then(
      answer => {
        if (!live) return;
        setReading(previous =>
          answer.kind === 'page'
            ? { status: 'ready', page: answer }
            : {
                status: 'paused',
                until: answer.until,
                ...('page' in previous && previous.page ? { page: previous.page } : {}),
              },
        );
      },
      (cause: unknown) => {
        if (!live) return;
        setReading(previous =>
          previous.status === 'ready'
            ? { status: 'ready', page: previous.page, stale: reasonOf(cause) }
            : { status: 'failed', message: reasonOf(cause) },
        );
      },
    );
    return () => {
      live = false;
    };
  }, [client, project, owner, name, number, tick]);
  return { reading, refresh: useCallback(() => setTick(value => value + 1), []) };
}

function Pause({ until }: { readonly until: string }) {
  return (
    <p className="kt-panel m-0 p-panel text-meta text-warn" data-pull-paused="" role="status">
      {budgetSentence(localTime(until))}. Nothing is read until then; Refresh tries again.
    </p>
  );
}

function Body({ page }: { readonly page: PullPage }) {
  const [tab, setTab] = useState<TabId>('conversation');
  const { pull } = page;
  return (
    <>
      <PullHeader pull={pull} />
      <UnderlineTabs
        current={tab}
        label="Pull request"
        marker="data-pull-tab"
        onSelect={setTab}
        tabs={[
          { id: 'conversation', label: `Conversation (${page.comments.length + page.reviews.length})` },
          { id: 'files', label: `Files (${pull.changedFiles})` },
          { id: 'ci', label: 'CI' },
        ]}
      />
      {tab === 'conversation' && <Conversation page={page} />}
      {tab === 'files' && <FilesTab pull={pull} />}
      {tab === 'ci' && <CiTab checks={page.checks} pull={pull} />}
    </>
  );
}

/** One pull request: header, then Conversation · Files · CI. Strangers' text is drawn inert (see `SafeProse`). */
export function PullPageView({
  client,
  daemon,
  address,
  onNavigate,
}: {
  readonly client: PullsClient;
  readonly daemon: string;
  readonly address: PullAddress;
  readonly onNavigate: (to: string) => void;
}) {
  const { reading, refresh } = useReading(client, address);
  const page = reading.status === 'ready' ? reading.page : reading.status === 'paused' ? reading.page : undefined;
  return (
    <main
      className="h-full min-h-0 overflow-y-auto p-panel"
      data-pull-page={`${address.owner}/${address.name}#${String(address.number)}`}
    >
      <div className="mx-auto grid w-full max-w-4xl content-start gap-panel">
        <div className="flex items-center justify-between gap-md">
          <button
            className="inline-flex w-fit items-center gap-xs text-meta text-muted hover:text-fg"
            type="button"
            onClick={() => onNavigate(projectPagePath(daemon, address.project))}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to project
          </button>
          <button className="kt-btn kt-btn--sm" disabled={reading.status === 'loading'} onClick={refresh} type="button">
            Refresh
          </button>
        </div>
        {reading.status === 'loading' && <Loading kind="bar" label="Loading this pull request…" />}
        {reading.status === 'failed' && (
          <p className="kt-panel m-0 p-panel text-meta text-warn" data-pull-failed="" role="alert">
            Could not read this pull request: {reading.message}
          </p>
        )}
        {reading.status === 'paused' && <Pause until={reading.until} />}
        {reading.status === 'ready' && reading.stale !== undefined && (
          <p className="m-0 text-meta text-warn" data-pull-stale="" role="status">
            This is the last page read; refreshing failed: {reading.stale}
          </p>
        )}
        {page !== undefined && <Body page={page} />}
      </div>
    </main>
  );
}
