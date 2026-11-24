/**
 * THE INPUT MODAL: when the app opens (or a sign-in is raised while it is open), the pending input cards of THIS machine
 * show as a modal, one at a time, a code card first and the newest first. The shell mounts it once per paired machine at
 * the frame root (`shell.background`, so it is there on every page, phone included), and it draws nothing while no card
 * is waiting.
 *
 * - THE LIST is the machine's own (`GET /v1/input-requests`), read on mount, whenever an ask changes, and every few
 *   seconds while a card is on screen (the daemon re-observes a card's target on its own; Send comes back by itself).
 * - A TAP names a card: `?ask=A3` on a notification's routed address opens exactly that card (`notificationOpened`).
 * - A STALE CARD (raised over a minute ago) is read again the moment it opens, not at the next poll.
 * - NOTHING SECRET is read or kept here: a card is facts and prompts, and the value is typed into `InputCard`, which
 *   sends it and forgets it. While the modal is open `<html data-fy-input-modal="open">` says so (`input-modal.ts`).
 *
 * The card's client is the shell's BACKGROUND client for this machine: it never raises a passkey prompt by itself.
 */
import { AsksChanged } from '@ferretry/core-asks/contract';
import type { BackgroundViewProps } from '@ferretry/app';
import { Dialog } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputRequest } from '../../../contract/index.ts';
import { listAllInputRequests } from '../../lib/input-api.ts';
import { titleWords } from '../../lib/input-card.ts';
import { chooseCard, holdModalSignal, isStale, orderPending, tappedAsks } from '../../lib/input-modal.ts';
import { InputCard } from './input-card.tsx';

const POLL_MS = 3_000;

export function InputModalHost({ daemon, client }: BackgroundViewProps) {
  const [requests, setRequests] = useState<readonly InputRequest[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>();
  const [settled, setSettled] = useState(false);
  // What the choosing reads between renders. The card on screen is kept as last read: once it is sent the daemon stops
  // listing it, and the card must still say what happened rather than vanish.
  const live = useRef({
    requests: [] as readonly InputRequest[],
    currentId: undefined as string | undefined,
    settled: false,
    dismissed: new Set<string>(),
    pinnedAsk: undefined as string | undefined,
    kept: undefined as InputRequest | undefined,
    reads: 0,
    alive: true,
  });

  const reselect = useCallback((list: readonly InputRequest[], read = true): void => {
    const now = live.current;
    const id = chooseCard({
      requests: list,
      currentId: now.currentId,
      settled: now.settled,
      dismissed: now.dismissed,
      pinnedAsk: now.pinnedAsk,
    });
    // A tap is honoured once: by the card it named, or by a READ that finds this machine has no such card.
    if (read) now.pinnedAsk = undefined;
    if (id !== now.currentId) {
      now.currentId = id;
      now.settled = false;
      setSettled(false);
      setCurrentId(id);
    }
  }, []);

  const relist = useCallback(async (): Promise<void> => {
    const now = live.current;
    const read = ++now.reads;
    try {
      const listed = await listAllInputRequests(client);
      // An older read that finished late must not undo a newer one.
      if (!now.alive || read !== now.reads) return;
      const open = listed.flatMap(each => (each.kind === 'open' ? [each.request] : []));
      now.requests = open;
      setRequests(open);
      reselect(open);
    } catch {
      // A machine that cannot be read right now shows what it last showed; the next read tries again.
    }
  }, [client, reselect]);

  const openAsk = useCallback(
    (ask: string): void => {
      live.current.pinnedAsk = ask;
      // The card may already be in hand: show it now; the read below confirms (or finds the machine has no such card).
      reselect(live.current.requests, false);
      void relist();
    },
    [reselect, relist],
  );

  useEffect(() => {
    const now = live.current;
    now.alive = true;
    void relist();
    const cancel = client.subscribe?.(AsksChanged, () => void relist());
    const tapped = tappedAsks.take(daemon);
    if (tapped !== undefined) openAsk(tapped);
    const unsubscribe = tappedAsks.subscribe(who => {
      if (who !== daemon) return;
      const ask = tappedAsks.take(daemon);
      if (ask !== undefined) openAsk(ask);
    });
    return () => {
      now.alive = false;
      cancel?.();
      unsubscribe();
    };
  }, [client, daemon, relist, openAsk]);

  const request = requests.find(each => each.id === currentId) ?? (settled ? live.current.kept : undefined);
  if (request !== undefined && request.id === currentId) live.current.kept = request;
  const open = request !== undefined;

  // The one plain signal that a modal is up (read by the parts of the app that must not move the screen under it).
  useEffect(() => (open ? holdModalSignal() : undefined), [open]);

  // While a card is on screen: read again every few seconds.
  useEffect(() => {
    if (currentId === undefined || settled) return;
    const timer = setInterval(() => void relist(), POLL_MS);
    return () => clearInterval(timer);
  }, [currentId, settled, relist]);

  // A card raised over a minute ago was last observed then: read it again the moment it opens.
  useEffect(() => {
    const opened = live.current.requests.find(each => each.id === currentId);
    if (opened !== undefined && !live.current.settled && isStale(opened, Date.now())) void relist();
  }, [currentId, relist]);

  if (request === undefined) return null;

  const waiting = orderPending(requests).filter(each => each.id !== request.id && !live.current.dismissed.has(each.id));
  const next = (): void => {
    const now = live.current;
    now.dismissed.add(request.id);
    now.settled = false;
    now.currentId = undefined;
    now.kept = undefined;
    setSettled(false);
    setCurrentId(undefined);
    reselect(now.requests);
  };
  const later = (): void => {
    const now = live.current;
    for (const each of now.requests) now.dismissed.add(each.id);
    next();
  };

  return (
    <Dialog
      ariaLabel="A ferret needs you to type something"
      closeLabel="Not now"
      footer={
        waiting.length === 0 && !settled ? undefined : (
          <div className="flex w-full items-center justify-between gap-3">
            <p className="m-0 text-meta text-muted" data-input-modal-more="">
              {waiting.length === 0 ? '' : `${waiting.length} more waiting`}
            </p>
            {settled ? (
              <button className="kt-btn" data-input-modal-next="" data-variant="primary" onClick={next} type="button">
                {waiting.length === 0 ? 'Close' : 'Next'}
              </button>
            ) : null}
          </div>
        )
      }
      onClose={later}
      open
      title={titleWords(request, 'The ferret')}
      width="34rem"
    >
      <div data-input-modal="" data-input-modal-request={request.id}>
        <InputCard
          client={client}
          embedded
          key={request.id}
          onDone={() => {
            live.current.settled = true;
            setSettled(true);
            void relist();
          }}
          onRefresh={() => void relist()}
          request={request}
        />
      </div>
    </Dialog>
  );
}
