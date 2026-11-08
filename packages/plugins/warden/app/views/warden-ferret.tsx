/**
 * The Warden's two contributions to Ferrets' own pages, each reading only through the half's own client and the ferret
 * the slot hands it:
 *
 *  - `ferret-warden` on `ferret.side`: what the Warden has said and done about this ferret (today's Info › Overview ›
 *    Warden section);
 *  - `ask-warden-row` on `ferrets.actions-row`: the Actions ▾ row "Ask the Warden to investigate now…", which opens its form
 *    in a dialog. The row is offered only to a caller who may control the ferret and whose grants open `warden.use` (a
 *    passkey step-up counts as open: the carrier asks for it at the request, through the shell's mounted seam — this
 *    code holds no ceremony). A grants read that fails offers nothing.
 */

import { type ActionsRowOffer, FerretSummarySchema, isActionsRowSlotProps } from '@ferretry/core-ferrets/contract';
import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { AskWardenForm, ASK_WARDEN_ACTION_ID } from '../features/warden/ask-warden.tsx';
import { mayAskWarden } from '../features/warden/ask-warden-model.ts';
import { FerretVerdicts, type FerretVerdictsRead } from '../features/warden/ferret-verdicts.tsx';
import { displayCallsign } from '../lib/callsign.ts';
import { failureMessage } from '../lib/form-parts.tsx';
import { readGrants } from '../lib/grants.ts';
import { wardenClientOf } from '../lib/warden-client.ts';
import { useDialogFocus } from '../ui.ts';

const FERRETS_ROUTE = 'GET /v1/ferrets' as const;
const FerretsSchema = z.array(FerretSummarySchema);

/** What the ferret is called, read through the same client; unread, the sentence says "this ferret". */
function useFerretName(client: PluginClient, ferret: string): string {
  const [name, setName] = useState<{ readonly ferret: string; readonly name: string } | null>(null);
  useEffect(() => {
    let live = true;
    void client.call<unknown>(FERRETS_ROUTE).then(
      rows => {
        const found = FerretsSchema.parse(rows).find(row => row.id === ferret);
        if (live && found !== undefined) setName({ ferret, name: displayCallsign(found.name) || found.id });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, ferret]);
  return name !== null && name.ferret === ferret ? name.name : 'this ferret';
}

/** `ferret.side` — the Warden's verdicts about the ferret the panel sits beside. */
export function createWardenFerretPanel(client: PluginClient) {
  return function WardenFerretPanel({ subject }: PanelProps) {
    const ferret = subject ?? '';
    const warden = useMemo(() => wardenClientOf(client), []);
    const [read, setRead] = useState<{ readonly ferret: string; readonly value: FerretVerdictsRead } | null>(null);
    useEffect(() => {
      if (ferret === '') return;
      let live = true;
      warden.verdicts().then(
        verdicts => {
          if (live) setRead({ ferret, value: { kind: 'ready', verdicts } });
        },
        (reason: unknown) => {
          if (live) setRead({ ferret, value: { kind: 'failed', reason: failureMessage(reason) } });
        },
      );
      return () => {
        live = false;
      };
    }, [warden, ferret]);
    const name = useFerretName(client, ferret);
    if (ferret === '') return null;
    return (
      <FerretVerdicts
        ferret={ferret}
        name={name}
        now={Date.now}
        verdicts={read !== null && read.ferret === ferret ? read.value : { kind: 'loading' }}
      />
    );
  };
}

const ROW_LABEL = 'Ask the Warden to investigate now…';

/** The form's dialog: Escape and a click outside close it; focus is kept inside while it is open. */
function AskDialog({
  ferret,
  name,
  client,
  onClose,
  onNotice,
}: {
  readonly ferret: string;
  readonly name: string;
  readonly client: PluginClient;
  readonly onClose: () => void;
  readonly onNotice: (sentence: string) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  const ports = useMemo(() => {
    const warden = wardenClientOf(client);
    return { status: () => warden.status(), investigate: warden.investigate };
  }, [client]);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button type="button" aria-label="Close" className="absolute inset-0" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="kt-panel relative flex w-full max-w-md flex-col gap-sm p-cell-x shadow-popover focus:outline-none"
        data-ask-warden-dialog=""
      >
        <header className="flex items-center justify-between gap-sm">
          <h2 className="m-0 text-cell font-semibold" id={titleId}>
            Ask the Warden to investigate {name}
          </h2>
          <button type="button" aria-label="Close" className="kt-btn h-9 w-9 shrink-0 p-0" onClick={onClose}>
            <X aria-hidden="true" size={15} />
          </button>
        </header>
        <AskWardenForm
          ferret={ferret}
          host={{ close: onClose, open: () => undefined, notify: onNotice, compact: false }}
          name={name}
          ports={ports}
        />
      </div>
    </div>
  );
}

function AskWardenRow({
  client,
  ferret,
  name,
  canControl,
  offer,
}: {
  readonly client: PluginClient;
  readonly ferret: string;
  readonly name: string;
  readonly canControl: boolean;
  readonly offer: (id: string, row: ActionsRowOffer | null) => void;
}) {
  const [allowed, setAllowed] = useState(false);
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readGrants(client)
      .then(mayAskWarden)
      .catch(() => false)
      .then(answer => {
        if (live) setAllowed(answer);
      });
    return () => {
      live = false;
    };
  }, [client]);
  const shown = allowed && canControl;
  useEffect(() => {
    if (!shown) {
      offer(ASK_WARDEN_ACTION_ID, null);
      return;
    }
    offer(ASK_WARDEN_ACTION_ID, {
      kind: 'run',
      id: ASK_WARDEN_ACTION_ID,
      label: ROW_LABEL,
      group: 'ferret',
      order: 90,
      run: () => {
        setNotice(null);
        setOpen(true);
      },
    });
    return () => offer(ASK_WARDEN_ACTION_ID, null);
  }, [shown, offer]);
  return (
    <>
      {open && shown ? (
        <AskDialog client={client} ferret={ferret} name={name} onClose={() => setOpen(false)} onNotice={setNotice} />
      ) : null}
      {notice === null ? null : (
        <p className="m-0 text-cell text-muted" data-ask-warden-notice="" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

/** `ferrets.actions-row` — the Warden's one row in a ferret's Actions menu. */
export function createAskWardenPanel(client: PluginClient) {
  return function AskWardenPanel(props: PanelProps) {
    return isActionsRowSlotProps(props) ? (
      <AskWardenRow
        canControl={props.canControl}
        client={client}
        ferret={props.ferret}
        name={props.name}
        offer={props.offer}
      />
    ) : null;
  };
}
