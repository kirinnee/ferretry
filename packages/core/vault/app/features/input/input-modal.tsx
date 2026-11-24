/**
 * THE INPUT MODAL: when the app opens (or a sign-in is raised while it is open), the pending input cards of THIS machine
 * show as a modal, one at a time, a code card first and the newest first. The shell mounts it once per paired machine at
 * the frame root (`shell.background`, so it is there on every page, phone included), and it draws nothing while no card
 * is waiting.
 *
 * - ONE MODAL AT A TIME, APP-WIDE. Every open dialog makes the rest of the page inert, so two machines' dialogs open
 *   together would lock each other out. A host with a card waits for its seat (`modalSeat`) and draws when it holds it;
 *   it keeps reading in the meantime. The Dialog stays MOUNTED while it waits and after it closes (`open` goes false
 *   rather than the host returning nothing), so the focus goes back to where it was and never to the page body.
 * - THE LIST is the machine's own (`GET /v1/input-requests`), read on mount, whenever an ask changes, and every few
 *   seconds while a card is on screen (the daemon re-observes a card's target on its own; Send comes back by itself).
 * - A TAP names a card: `?ask=A3` on a notification's routed address opens exactly that card (`notificationOpened`);
 *   an app opened COLD by the tap has the address instead, and the first host to mount reads it from there.
 * - A STALE CARD (raised over a minute ago) is looked at again by the daemon (`observeInput`) the moment it opens, and
 *   then read again, so a redrawn target is what the owner types into rather than a failed Send.
 * - A LOCKED MACHINE says so on the card and points at the Unlock on that machine's page: its reads wait for the
 *   unlock, and a card that quietly never refreshes is a failure nobody sees.
 * - NOTHING SECRET is read or kept here: a card is facts and prompts, and the value is typed into `InputCard`, which
 *   sends it and forgets it. While the modal is open `<html data-fy-input-modal="open">` says so (`input-modal.ts`).
 *
 * The card's client is the shell's BACKGROUND client for this machine: it never raises a passkey prompt by itself.
 */
import { AsksChanged } from '@ferretry/core-asks/contract';
import { type BackgroundViewProps, useLockedDaemons } from '@ferretry/app';
import { Dialog } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { InputRequest } from '../../../contract/index.ts';
import { listAllInputRequests, observeInput } from '../../lib/input-api.ts';
import { titleWords } from '../../lib/input-card.ts';
import {
  chooseCard,
  holdModalSignal,
  isStale,
  modalSeat,
  orderPending,
  takeColdAsk,
  tappedAsks,
} from '../../lib/input-modal.ts';
import { InputCard } from './input-card.tsx';

const POLL_MS = 3_000;

export function InputModalHost({ daemon, client }: BackgroundViewProps) {
  const [requests, setRequests] = useState<readonly InputRequest[]>([]);
  const [currentId, setCurrentId] = useState<string | undefined>();
  // The card that has settled (sent, refused, cancelled), by ITS id: a late answer of a card the owner has already left
  // must never settle the one now on screen.
  const [settledId, setSettledId] = useState<string | undefined>();
  // A tapped ask no read has confirmed yet: a locked machine never answers, and the owner is told why.
  const [tappedWait, setTappedWait] = useState(false);
  const locked = useLockedDaemons().includes(daemon);
  // What the choosing reads between renders. The card on screen is kept as last read: once it is sent the daemon stops
  // listing it, and the card must still say what happened rather than vanish.
  const live = useRef({
    requests: [] as readonly InputRequest[],
    currentId: undefined as string | undefined,
    settledId: undefined as string | undefined,
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
      settled: now.settledId !== undefined && now.settledId === now.currentId,
      dismissed: now.dismissed,
      pinnedAsk: now.pinnedAsk,
    });
    // A tap is honoured once: by the card it named, or by a READ that finds this machine has no such card.
    if (read && now.pinnedAsk !== undefined) {
      now.pinnedAsk = undefined;
      setTappedWait(false);
    }
    if (id !== now.currentId) {
      now.currentId = id;
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
      setTappedWait(true);
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
    const tapped = tappedAsks.take(daemon) ?? takeColdAsk(daemon);
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

  const request =
    requests.find(each => each.id === currentId) ??
    (currentId !== undefined && settledId === currentId ? live.current.kept : undefined);
  if (request !== undefined && request.id === currentId) live.current.kept = request;
  const settled = request !== undefined && settledId === request.id;
  // A tap on a locked machine has no card to show yet: the notice alone is drawn, so the tap is never met by nothing.
  const noticeOnly = request === undefined && locked && tappedWait;
  const wants = request !== undefined || noticeOnly;

  // Join the queue while there is something to show; leave when there is not (a passive effect, so a closing card has
  // put the focus back before the next machine's modal opens).
  useEffect(() => (wants ? modalSeat.join(daemon) : undefined), [wants, daemon]);
  const seated = useSyncExternalStore(
    modalSeat.subscribe,
    () => modalSeat.holds(daemon),
    () => false,
  );
  const open = wants && seated;

  // The one plain signal that a modal is up (read by the parts of the app that must not move the screen under it).
  useEffect(() => (open ? holdModalSignal() : undefined), [open]);

  // While a card is on screen: read again every few seconds.
  useEffect(() => {
    if (!open || currentId === undefined || settled) return;
    const timer = setInterval(() => void relist(), POLL_MS);
    return () => clearInterval(timer);
  }, [open, currentId, settled, relist]);

  // A card raised over a minute ago was last observed then: the daemon looks at its target again the moment it opens,
  // and the card is read again for what it saw.
  const shownId = open ? currentId : undefined;
  useEffect(() => {
    const opened = live.current.requests.find(each => each.id === shownId);
    if (opened === undefined || live.current.settledId === opened.id || !isStale(opened, Date.now())) return;
    void observeInput(client, opened)
      .catch(() => undefined)
      .then(() => relist());
  }, [shownId, client, relist]);

  const waiting =
    request === undefined
      ? []
      : orderPending(requests).filter(each => each.id !== request.id && !live.current.dismissed.has(each.id));
  const next = (): void => {
    const now = live.current;
    if (request !== undefined) now.dismissed.add(request.id);
    now.currentId = undefined;
    now.kept = undefined;
    setCurrentId(undefined);
    reselect(now.requests);
  };
  const later = (): void => {
    const now = live.current;
    for (const each of now.requests) now.dismissed.add(each.id);
    // A tap that was waiting on a locked machine is put off with the rest.
    now.pinnedAsk = undefined;
    setTappedWait(false);
    next();
  };
  const settle = (id: string): void => {
    live.current.settledId = id;
    setSettledId(id);
    void relist();
  };

  return (
    <Dialog
      ariaLabel="A ferret needs you to type something"
      closeLabel="Not now"
      footer={
        request === undefined || (waiting.length === 0 && !settled) ? undefined : (
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
      open={open}
      title={request === undefined ? 'This machine is locked' : titleWords(request, 'The ferret')}
      width="34rem"
    >
      <div data-input-modal="" data-input-modal-request={request?.id}>
        {locked ? (
          <p className="m-0 mb-3 text-ui leading-base text-warn" data-input-modal-locked="" role="status">
            This machine is locked, so what you see here may be out of date
            {request === undefined ? ' and cannot be read yet' : ''}. Choose “Not now”, then press Unlock at the top of
            this machine’s page.
          </p>
        ) : null}
        {request === undefined ? null : (
          <InputCard
            client={client}
            embedded
            key={request.id}
            onDone={() => settle(request.id)}
            onRefresh={() => void relist()}
            request={request}
          />
        )}
      </div>
    </Dialog>
  );
}
