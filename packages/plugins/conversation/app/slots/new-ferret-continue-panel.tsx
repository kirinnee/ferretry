/**
 * "CONTINUE A PAST CONVERSATION" ON THE NEW FERRET PAGE (`panels['new-ferret-continue']`, slot `ferrets.new-ferret-continue`,
 * contract/slots.ts of Ferrets). The page hands the row now in its form and a way to put one there; this draws the list of
 * the conversations the daemon knows (and the stopped ferrets), searchable, newest first.
 *
 * A conversation a ferret already keeps resumes (or opens) THAT ferret in place: Ferrets' own resume, never a second ferret on
 * the same conversation. Any other is picked into the form, and the page's Create starts it as a ferret that names the
 * conversation, so the harness resumes it.
 *
 * Ferrets' list and resume are called by route key through this half's client (Ferrets is a need).
 */

import { useOptionalRouter, useScreenHref } from '@ferretry/app';
import { type FerretSummary, FerretSummarySchema, isNewFerretContinueSlotProps } from '@ferretry/core-ferrets/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { ContinueConversation } from '../links/continue-conversation.tsx';
import { guarded } from '../links/link-refusal.ts';

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

export function NewFerretContinuePanel(props: PanelProps): ReactNode {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  const router = useOptionalRouter();
  const href = useScreenHref();
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

  const resume = useCallback((ferretId: string) => resumeFerret(client, ferretId), [client]);
  const openFerret = useCallback(
    (ferret: string) => {
      if (daemon === undefined) return;
      const to = href(daemon, 'conversation', 'chat', { ferret });
      if (to !== undefined) router?.navigate(to);
    },
    [daemon, href, router],
  );

  if (daemon === undefined || !isNewFerretContinueSlotProps(props)) return null;
  return (
    <ContinueConversation
      client={client}
      daemon={daemon}
      ferrets={ferrets}
      onOpenFerret={openFerret}
      onPick={props.onPick}
      picked={props.picked}
      resume={resume}
    />
  );
}
