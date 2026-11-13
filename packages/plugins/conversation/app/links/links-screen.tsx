/**
 * THE CONVERSATIONS SCREEN (`screens.links`, `/links`, nav "Conversations"): the harness conversations this daemon can
 * see, in one place. Today these were three surfaces — New session › Continue, Settings › Runtimes › Import
 * conversations and the Imported history page — and they are the three parts of this screen:
 *
 *   Continue   one list of conversations and stopped ferrets, with a preview and the button that continues one
 *   Keep       pick conversations to keep as ferrets, read from the harness's own file (a link)
 *   History    the harnesses' own history, read-only
 *
 * Ferrets' list and resume are called by route key through this half's client (Ferrets is a need), and a ferret
 * opens on Conversation's own chat screen.
 */

import { useOptionalRouter, useScreenHref } from '@ferretry/app';
import { type FerretSummary, FerretSummarySchema } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { ContinueConversation } from './continue-conversation.tsx';
import { KeepConversations, runtimeSlotField, Segmented } from './conversation-picker.tsx';
import { HistoryPage, readHistory, readHistoryEntry } from './history-page.tsx';
import { guarded, LinkNote } from './link-ui.tsx';

export type LinksPart = 'continue' | 'keep' | 'history';

const PARTS: readonly { readonly id: LinksPart; readonly label: string }[] = [
  { id: 'continue', label: 'Continue' },
  { id: 'keep', label: 'Keep' },
  { id: 'history', label: 'History' },
];

/** Ferrets' `GET /v1/ferrets`: every ferret's summary. */
const readFerrets = async (client: Pick<PluginClient, 'call'>): Promise<readonly FerretSummary[]> =>
  z.array(FerretSummarySchema).parse(await client.call('GET /v1/ferrets'));

/** Ferrets' resume: a stopped ferret relaunches its harness on the same conversation. */
const resumeFerret = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<void> => {
  await client.call('POST /v1/ferrets/:ferretId/resume', {
    params: { ferretId },
    body: {},
    headers: { 'x-fy-request-id': crypto.randomUUID() },
  });
};

export function LinksScreen({ initial = 'continue' }: { readonly initial?: LinksPart }) {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  const router = useOptionalRouter();
  const href = useScreenHref();
  const [part, setPart] = useState<LinksPart>(initial);
  const [ferrets, setFerrets] = useState<readonly FerretSummary[] | null>(null);

  useEffect(() => {
    let live = true;
    void guarded(() => readFerrets(client)).then(answer => {
      // A list that cannot be read marks no conversation and lists no stopped ferret; the conversations still list.
      if (live) setFerrets(answer.kind === 'done' ? answer.value : []);
    });
    return () => {
      live = false;
    };
  }, [client]);

  // Stable, because the history page reads once per reader it is handed.
  const history = useCallback(() => readHistory(client), [client]);
  const historyEntry = useCallback((entryId: string) => readHistoryEntry(client, entryId), [client]);
  // Which runtime a conversation is kept on: the slot Ferrets offers, where Runtimes draws its picker.
  const runtimeField = useMemo(() => (daemon === undefined ? undefined : runtimeSlotField(daemon)), [daemon]);
  const resume = useCallback((ferretId: string) => resumeFerret(client, ferretId), [client]);

  const openFerret = useCallback(
    (ferret: string) => {
      if (daemon === undefined) return;
      const to = href(daemon, 'conversation', 'chat', { ferret });
      if (to !== undefined) router?.navigate(to);
    },
    [daemon, href, router],
  );

  if (daemon === undefined || runtimeField === undefined)
    return (
      <LinkNote tone="warn" name="links-no-daemon">
        <span>This screen needs a daemon to read conversations from.</span>
      </LinkNote>
    );

  return (
    <section aria-labelledby="links-heading" className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 sm:px-8">
      <h1 id="links-heading" className="m-0 font-display text-3xl font-bold tracking-display">
        Conversations
      </h1>
      <div className="w-72 max-w-full">
        <Segmented<LinksPart> label="Show" name="links-part" options={PARTS} value={part} onChoose={setPart} />
      </div>
      {part === 'continue' ? (
        <ContinueConversation
          client={client}
          daemon={daemon}
          ferrets={ferrets}
          onOpenFerret={openFerret}
          runtimeField={runtimeField}
          resume={resume}
        />
      ) : part === 'keep' ? (
        <KeepConversations client={client} runtimeField={runtimeField} />
      ) : (
        <HistoryPage daemon={daemon} readHistory={history} readEntry={historyEntry} />
      )}
    </section>
  );
}
