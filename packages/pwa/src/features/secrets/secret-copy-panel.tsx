/**
 * Copying secrets between two machines this browser is paired with (docs/secrets.md).
 *
 * Pick the other machine → tick the secrets (names, and where each is used) → **Copy** → the SENDING
 * machine asks for a passkey for this copy → "3 secrets copied". The same panel serves both ends: on a
 * new machine's setup it copies FROM another machine; in Settings › Secrets it copies TO one.
 *
 * NOTHING HERE EVER HOLDS A VALUE. The two lists are names; the copy itself is three calls in
 * `secret-clone-api.ts`, and what passes through this browser between them is ciphertext sealed to a
 * key only the receiving machine has. The passkey prompt is the app's one prompt, raised by the carrier
 * when the sending machine refuses for want of it — this panel only waits.
 */

import type { SecretImportResult, SecretList } from '@ferretry/protocol';
import { ArrowRightLeft, CheckCircle2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { copySecrets, type SecretCloneClient } from './secret-clone-api.ts';
import {
  copiedSentence,
  copyableRows,
  copyButtonLabel,
  copyRefusalSentence,
  initialPicks,
  SECRET_COPY_PROMISE,
  type SecretCopyRow,
  secretCopyRows,
} from './secret-clone-model.ts';
import { listSecrets } from './secrets-api.ts';

export interface SecretCopyPanelProps {
  /** `from`: this machine RECEIVES and the person picks where from. `to`: this machine SENDS. */
  readonly direction: 'from' | 'to';
  readonly here: DaemonConnection;
  /** The other machines this browser is paired with; never `here`. */
  readonly others: readonly DaemonConnection[];
  readonly createClient: (connection: DaemonConnection) => Promise<SecretCloneClient>;
  readonly machineName: (connection: DaemonConnection) => string;
  /** Names to start ticked — the secrets a copied setup needs, say. */
  readonly preselect?: readonly string[];
  readonly onCopied?: (result: SecretImportResult) => void;
  readonly onClose?: () => void;
}

type Lists =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly sentence: string }
  | { readonly kind: 'ready'; readonly source: SecretList; readonly rows: readonly SecretCopyRow[] };

type Phase =
  | { readonly kind: 'pick' }
  | { readonly kind: 'copying' }
  | { readonly kind: 'done'; readonly result: SecretImportResult }
  | { readonly kind: 'refused'; readonly sentence: string };

export function SecretCopyPanel(props: SecretCopyPanelProps) {
  const { direction, here, others, createClient, machineName, preselect = [], onCopied, onClose } = props;
  const uid = useId();
  const [otherId, setOtherId] = useState<string | null>(others.length === 1 ? String(others[0]?.daemonId) : null);
  const other = others.find(candidate => String(candidate.daemonId) === otherId) ?? null;
  const source = direction === 'from' ? other : here;
  const target = direction === 'from' ? here : other;
  const [lists, setLists] = useState<Lists>({ kind: 'loading' });
  const [picks, setPicks] = useState<readonly string[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  // Read through a ref so the lists load once per PAIR of machines: a parent that re-renders with a fresh
  // array, or a new `preselect`, must not reload the lists or undo the ticks a person already made.
  const latest = useRef({ source, target, preselect });
  latest.current = { source, target, preselect };
  const pairKey = source === null || target === null ? null : `${source.daemonId} ${target.daemonId}`;

  useEffect(() => {
    const { source, target, preselect } = latest.current;
    if (pairKey === null || source === null || target === null) return;
    let live = true;
    setLists({ kind: 'loading' });
    setPhase({ kind: 'pick' });
    void (async () => {
      try {
        const sourceList = await listSecrets(await createClient(source));
        // The receiving machine's names only mark replacements; a list it cannot answer marks none.
        const targetNames = await createClient(target)
          .then(listSecrets)
          .then(list => (list.health === 'ready' ? new Set(list.secrets.map(secret => secret.name)) : null))
          .catch(() => null);
        if (!live) return;
        const rows = secretCopyRows(sourceList, targetNames);
        setLists({ kind: 'ready', source: sourceList, rows });
        setPicks(initialPicks(rows, preselect));
      } catch (error) {
        if (live) setLists({ kind: 'failed', sentence: copyRefusalSentence(error) });
      }
    })();
    return () => {
      live = false;
    };
  }, [pairKey, createClient]);

  const copy = async (): Promise<void> => {
    if (source === null || target === null || picks.length === 0) return;
    setPhase({ kind: 'copying' });
    try {
      const result = await copySecrets(await createClient(source), await createClient(target), picks);
      setPhase({ kind: 'done', result });
      onCopied?.(result);
    } catch (error) {
      setPhase({ kind: 'refused', sentence: copyRefusalSentence(error) });
    }
  };

  const toggle = (name: string, on: boolean): void =>
    setPicks(current =>
      on ? [...current.filter(entry => entry !== name), name] : current.filter(entry => entry !== name),
    );

  const title = direction === 'from' ? 'Copy secrets from another machine' : 'Copy secrets to another machine';

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
      aria-labelledby={`${uid}-title`}
      data-secret-copy={direction}
    >
      <h3 id={`${uid}-title`} className="m-0 flex items-center gap-1.5 text-row font-semibold text-fg">
        <ArrowRightLeft size={16} className="shrink-0 text-accent" aria-hidden="true" />
        {title}
      </h3>
      <p className="m-0 text-cell leading-base text-muted">{SECRET_COPY_PROMISE}</p>

      {others.length === 0 ? (
        <p className="m-0 text-ui text-faint" data-secret-copy-alone="">
          This browser is paired with no other machine yet. Pair one, then copy.
        </p>
      ) : (
        <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
          <legend className="mb-1 p-0 text-cell font-medium text-fg">{direction === 'from' ? 'From' : 'To'}</legend>
          {others.map(candidate => (
            <label
              key={String(candidate.daemonId)}
              className="flex min-h-[44px] min-w-0 items-center gap-2 rounded-control border border-border-strong bg-surface-2 px-3 text-ui text-fg"
            >
              <input
                type="radio"
                name={`${uid}-machine`}
                checked={otherId === String(candidate.daemonId)}
                disabled={phase.kind === 'copying'}
                onChange={() => setOtherId(String(candidate.daemonId))}
              />
              <span className="min-w-0 truncate">{machineName(candidate)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {source !== null && target !== null && (
        <CopyBody
          uid={uid}
          lists={lists}
          picks={picks}
          phase={phase}
          sourceName={machineName(source)}
          targetName={machineName(target)}
          onToggle={toggle}
          onAll={on => setPicks(on && lists.kind === 'ready' ? copyableRows(lists.rows).map(row => row.name) : [])}
          onCopy={() => void copy()}
        />
      )}

      {onClose !== undefined && (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="kt-btn min-h-[44px]" onClick={onClose} disabled={phase.kind === 'copying'}>
            {phase.kind === 'done' ? 'Done' : 'Close'}
          </button>
        </div>
      )}
    </section>
  );
}

interface CopyBodyProps {
  readonly uid: string;
  readonly lists: Lists;
  readonly picks: readonly string[];
  readonly phase: Phase;
  readonly sourceName: string;
  readonly targetName: string;
  readonly onToggle: (name: string, on: boolean) => void;
  readonly onAll: (on: boolean) => void;
  readonly onCopy: () => void;
}

function CopyBody({ uid, lists, picks, phase, sourceName, targetName, onToggle, onAll, onCopy }: CopyBodyProps) {
  if (lists.kind === 'loading')
    return (
      <p className="m-0 text-ui text-faint" role="status">
        Reading the secrets on {sourceName}…
      </p>
    );
  if (lists.kind === 'failed')
    return (
      <p className="m-0 text-ui text-err" role="alert">
        {lists.sentence}
      </p>
    );
  if (lists.source.health === 'damaged')
    return (
      <p className="m-0 text-ui text-warn" role="alert" data-secret-copy-damaged="">
        {sourceName} cannot read its own secret store, so there is nothing it can copy until it can.
      </p>
    );
  if (phase.kind === 'done')
    return (
      <p className="m-0 flex items-start gap-2 text-ui text-fg" role="status" data-secret-copy-done="">
        <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-ok" aria-hidden="true" />
        {copiedSentence(phase.result, targetName)}
      </p>
    );
  if (lists.rows.length === 0)
    return (
      <p className="m-0 text-ui text-faint" data-secret-copy-empty="">
        {sourceName} holds no secrets.
      </p>
    );
  const copying = phase.kind === 'copying';
  const everything = picks.length === copyableRows(lists.rows).length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${uid}-list`} className="m-0 text-cell font-medium text-fg">
          Secrets on {sourceName}
        </p>
        <button
          type="button"
          className="kt-btn kt-btn--sm min-h-[44px]"
          disabled={copying}
          onClick={() => onAll(!everything)}
        >
          {everything ? 'Select none' : 'Select all'}
        </button>
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-col gap-2 p-0" aria-labelledby={`${uid}-list`}>
        {lists.rows.map(row => (
          <li key={row.name} className="min-w-0">
            <label
              className="flex min-h-[44px] min-w-0 items-start gap-2 rounded-control border border-border-strong bg-surface-2 px-3 py-2"
              data-secret-copy-row={row.name}
            >
              <input
                type="checkbox"
                className="mt-1 shrink-0"
                checked={picks.includes(row.name)}
                disabled={copying || row.signIn}
                onChange={event => onToggle(row.name, event.target.checked)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="mono min-w-0 truncate text-ui font-medium text-fg">{row.name}</span>
                  {row.onTarget && (
                    <span className="rounded-control bg-warn/10 px-1.5 text-meta font-medium text-warn">
                      replaces {targetName}’s
                    </span>
                  )}
                </span>
                <span className="text-meta leading-base text-muted">
                  {row.signIn
                    ? `A sign-in isn’t copied. Sign in again on ${targetName}.`
                    : row.uses.length === 0
                      ? 'No setting names it'
                      : `Used by ${row.uses.join(', ')}`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      {phase.kind === 'refused' && (
        <p className="m-0 text-ui text-err" role="alert">
          {phase.sentence}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="kt-btn min-h-[44px] justify-center"
          data-variant="primary"
          disabled={copying || picks.length === 0}
          onClick={onCopy}
        >
          {copying ? 'Copying…' : copyButtonLabel(picks.length)}
        </button>
        <span className="text-meta text-faint">
          {copying ? `Confirm with your passkey on ${sourceName} if asked.` : `${sourceName} → ${targetName}`}
        </span>
      </div>
    </div>
  );
}

/** A button that opens the panel in place: "Copy secrets from studio…". Closing it puts the button back. */
export function SecretCopyLauncher({ label, ...panel }: SecretCopyPanelProps & { readonly label: string }) {
  const [open, setOpen] = useState(false);
  if (open) return <SecretCopyPanel {...panel} onClose={() => setOpen(false)} />;
  return (
    <div>
      <button type="button" className="kt-btn min-h-[44px]" onClick={() => setOpen(true)} data-secret-copy-launch="">
        <ArrowRightLeft size={14} aria-hidden="true" /> {label}
      </button>
    </div>
  );
}
