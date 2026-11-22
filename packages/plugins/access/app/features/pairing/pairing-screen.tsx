/**
 * The public PWA's runtime pairing surface — one screen, one action.
 *
 * A daemon address and device credential never come from the static bundle:
 * the host exchanges a one-time pairing link, then owns persistence in the
 * daemon connection registry. This screen deliberately sees only the resulting
 * connection metadata, the arrival it was opened with, and injected callbacks.
 *
 * WHAT ARRIVES HERE, IN ORDER OF HOW OFTEN IT HAPPENS. The design's pairing
 * flow (`docs/design/split-proposal.md` §5) puts the daemon's QR in the
 * terminal and on a loopback page, and the QR encodes a link to `/pair#v1;…` —
 * one form, whether the device will reach the daemon at that address or fall back
 * to the rendezvous this build discovers for itself (`docs/relay-protocol.md` §14).
 * So the common arrival is a phone's ORDINARY camera app opening this page
 * already carrying the code, and this screen's job there is a confirmation, not
 * a form. A cold open gets the camera button. Paste is the last-resort path and
 * is a quiet secondary, revealed on demand — or automatically, the moment a
 * scan is refused.
 *
 * THE WORD COUNT IS A FEATURE. Everything above the fold on a phone has to be
 * readable in a glance: a heading, one line, one control. The security model —
 * true, and worth saying — sits in a disclosure at the bottom rather than in
 * three paragraphs above the only button.
 *
 * A ZERO-DAEMON EMPTY STATE RENDERS NOTHING. A card containing the number 0 and
 * a sentence explaining that it is 0 is noise; the list earns its place once
 * there is something in it.
 */
import { ActionRow, SecretInput, useSecretField } from '@ferretry/app/ui';
import { Check, ChevronRight, Link2, ShieldCheck, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type DaemonPath, describeDaemonPath, describeListedDaemon } from '@ferretry/plugin-connections/contract';
import {
  BrandMark,
  type DaemonConnectionRecord,
  type DaemonId,
  RelayPairingRefusedError,
} from '../../shell-pairing.ts';
import type { QrScanHost } from '../../lib/pair-scan.ts';
import { usePairingScreenMarker } from '../../lib/pairing-screen-marker.ts';
import { type PairingArrival, pairingSeedFromUrl, type PairingSeed } from '../../lib/pairing.ts';
import { DeviceKeyUnsupportedError } from '../../lib/device-keys.ts';
import { browserDeviceName } from '@ferretry/app';
import { normalizedDeviceName } from '../../lib/device-name.ts';
import { FerretMascot, type FerretPose } from './ferret-mascot.tsx';
import { MachineNameField, machineNameChoice } from './machine-name-field.tsx';
import { ConfirmActions, DeviceNameLine, LineWithDetails, PairProgress } from './pair-confirm-pieces.tsx';
import { PairScanner } from './pair-scanner.tsx';
import {
  FirstPasskeyOffer,
  type FirstPasskeyClientFactory,
  type FirstPasskeyOfferProps,
} from './first-passkey-offer.tsx';
import type { DaemonConnection } from '../../shell-grants.ts';
import { PairedNext } from './paired-next.tsx';
import { PairButton, PairingBack } from './pairing-back.tsx';
import { PairingSky } from './pairing-sky.tsx';

/** What the exchange learned, so the screen can say how it got there. Both parts are optional: a host may know neither. */
interface PairedAs {
  /** What the daemon calls its machine. */
  readonly machine?: string;
  /** Which path carried the exchange. */
  readonly via?: 'direct' | 'relay';
  /** The machine just paired with, so the success screen can offer its first passkey while that window is open. */
  readonly connection?: DaemonConnection;
}

/**
 * Exchanges the code; `deviceName` is what the person called this device on the confirm screen, and `machineName`
 * (absent when the field was left empty) what they called the machine, for the host to save once paired.
 */
type PairingExchange = (seed: PairingSeed, deviceName: string, machineName?: string) => Promise<PairedAs | void>;

/** Whether this page runs on a loopback address, i.e. on the daemon's own machine. */
const pageIsLocal = (): boolean => {
  const host = globalThis.location?.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
};

export interface PairingScreenProps {
  /** Existing pairings from the host-owned, browser-local registry. */
  readonly connections: readonly DaemonConnectionRecord[];
  readonly selectedDaemonId: DaemonId | null;
  /** How this tab was opened. Defaults to a cold open. */
  readonly arrival?: PairingArrival;
  /** The camera, or `null` where this browser has none to offer. */
  readonly scanHost?: QrScanHost | null;
  /** Reads a QR picture to its text; the page's own decoder unless a suite hands another. */
  readonly readImage?: (file: Blob) => Promise<string>;
  /** Exchanges the one-time code and adds the resulting connection. */
  readonly onPair: PairingExchange;
  /** Whether this page runs on the daemon's own machine. Defaults to reading the page's address. */
  readonly sameMachine?: boolean;
  readonly onSelect: (daemonId: DaemonId) => void;
  readonly onRemove: (daemonId: DaemonId) => void;
  /**
   * The arrival's single-use code has been taken into this screen's state and
   * should now leave the address bar. Called once, on first render.
   */
  readonly onArrivalTaken?: () => void;
  /** The name the confirm screen offers. The browser's own by default; a suite passes a fixed one. */
  readonly defaultName?: () => string;
  /**
   * Opens the setup guide. Absent while this screen IS a step of that guide —
   * a link back into the stepper from inside the stepper is a loop.
   */
  readonly onOpenSetup?: () => void;
  /**
   * Renders inside a host that already owns the page.
   *
   * The pairing ARC — scan, paste, confirm, exchange, fail, retry — is the same
   * in both housings and is deliberately not forked. What changes is only the
   * housing: a standalone screen is the page's `<main>` with the brand, the
   * heading and the run-`fy pair` line; embedded in the setup stepper it is a
   * plain section, because the stepper has already said all three and a second
   * `<main>` inside the first is not a landmark, it is a bug.
   */
  readonly embedded?: boolean;
  /**
   * Told `true` while the failure on screen is `stated` — its sentence is the whole remedy — and `false`
   * otherwise, so a host drops the advice it adds around this screen (the code expiring, the step
   * finishing itself), which is about the one thing that was working.
   */
  readonly onStatedFailure?: (stated: boolean) => void;
  /**
   * How the success screen reaches the machine just paired with, to offer "Add a passkey now" while its first-passkey
   * window is open (the daemon-less `/pair` page reaches it through Access's own passkey ports). Absent, no offer is made.
   */
  readonly passkeyClient?: FirstPasskeyClientFactory;
  /** Test seams of that offer (credentials, origin, browser support, clock); production reads the browser's own. */
  readonly passkeyOffer?: Pick<
    FirstPasskeyOfferProps,
    'credentials' | 'origin' | 'supported' | 'now' | 'deadlineMs' | 'schedule'
  >;
  /**
   * How a host that moves on by itself leaves the success screen (the daemon-less `/pair` page navigates to the machine's
   * home). With it, the screen waits for the passkey offer's answer before calling it: at once when there is nothing
   * to offer, or when the person presses "Not now" / "Continue". Absent (every embedded host), the screen stays and
   * nothing here changes. Called at most once per success.
   */
  readonly onContinue?: () => void;
  /**
   * The SLOT under the success message ("Connected. Paired with …"): a host that wants to offer one more thing right
   * after a pairing (a nudge to add a passkey, say) passes it here. It renders only on the success screen, below the
   * words and inside the same centred column, so it never competes with the mascot. Absent: nothing is drawn.
   */
  readonly afterPaired?: ReactNode;
  /** The way back out of this chrome-less page (`pairing-back.tsx`); absent, embedded, or on the success screen: none. */
  readonly onClose?: () => void;
}

/**
 * Where the reader is in the pairing arc.
 *
 * `failed` keeps the seed when there is one, because "the daemon refused" and
 * "there is nothing to retry" are different situations and only the first can
 * offer a retry. A code is single-use, so a retry is honest ONLY for a failure
 * that never reached the daemon — every other failure sends the reader back to
 * the start, which is what `fy pair` will give them.
 */
type Stage =
  | { readonly kind: 'browse' }
  | { readonly kind: 'confirm'; readonly seed: PairingSeed }
  | { readonly kind: 'pairing'; readonly seed: PairingSeed }
  | { readonly kind: 'paired'; readonly path: DaemonPath; readonly connection?: DaemonConnection }
  | { readonly kind: 'failed'; readonly message: string; readonly cause: PairingFailureCause };

/**
 * WHY A REDEMPTION FAILED, AS THE ONLY TWO ANSWERS THAT LEAD ANYWHERE DIFFERENT.
 *
 * `docs/relay-protocol.md` §14 draws exactly this line and says how a client keeps it: "A sealed
 * `pair-refused` is the opposite: the exchange happened, the answer is final for that attempt, and
 * the remedy is the direct route's own sentence — the code is wrong, expired or spent; mint a fresh
 * one. A client must keep the two apart, and it can do so structurally: one arrives as a close
 * outside the channel, the other as a record inside it."
 *
 * `refusal` therefore means the DAEMON judged this code, and the remedy is a fresh code.
 * `transport` means nothing reached the daemon at all, and telling that reader to mint a new code
 * would send them to redo the one thing that was not the problem.
 *
 * `stated` is a failure whose sentence already IS the remedy, and that neither of the other two fits:
 * a browser that cannot make the key Ferretry pairs with. Adding "check your network" beneath it would
 * be advice about the one thing that was working.
 *
 * There is deliberately no fourth value for "which refusal". §14 gives one machine reason for every
 * cause because a pre-auth surface the whole internet can reach must not be an oracle, and a screen
 * that branched further would be asking for a distinction the wire does not carry.
 */
export type PairingFailureCause = 'refusal' | 'transport' | 'stated';

const failureCause = (reason: unknown): PairingFailureCause => {
  if (reason instanceof RelayPairingRefusedError) return 'refusal';
  if (reason instanceof DeviceKeyUnsupportedError) return 'stated';
  return 'transport';
};

const BROWSE: Stage = { kind: 'browse' };

/** The stage a fresh mount starts in, decided entirely by how the tab was opened. */
const initialStage = (arrival: PairingArrival): Stage => {
  if (arrival.kind === 'seed') return { kind: 'confirm', seed: arrival.seed };
  if (arrival.kind === 'unreadable')
    return { kind: 'failed', message: `This pairing link is damaged: ${arrival.reason}.`, cause: 'transport' };
  return BROWSE;
};

const NO_ARRIVAL: PairingArrival = { kind: 'none' };

export function PairingScreen({
  connections,
  selectedDaemonId,
  arrival = NO_ARRIVAL,
  scanHost = null,
  readImage,
  onPair,
  onSelect,
  onRemove,
  onArrivalTaken,
  onOpenSetup,
  embedded = false,
  defaultName = browserDeviceName,
  onStatedFailure,
  passkeyClient,
  passkeyOffer,
  onContinue,
  sameMachine = pageIsLocal(),
  afterPaired,
  onClose,
}: PairingScreenProps) {
  const [stage, setStage] = useState<Stage>(() => initialStage(arrival));
  const statedFailure = stage.kind === 'failed' && stage.cause === 'stated';
  useEffect(() => {
    onStatedFailure?.(statedFailure);
  }, [onStatedFailure, statedFailure]);
  // Chosen once per screen, so a person editing it is never overwritten and two attempts send one name.
  const [deviceName, setDeviceName] = useState(defaultName);
  const [machineName, setMachineName] = useState('');
  const [pasting, setPasting] = useState(false);
  /** The pasted link holds a live code: it lives only in the input's own value, read on submit, never in state or markup. */
  const link = useSecretField(typed => typed.trim().length);
  const [linkError, setLinkError] = useState<string | null>(null);
  // A pasted link, or a seed taken from one, holds a live code: the page is marked for the whole of that (docs/pairing.md).
  usePairingScreenMarker(link.filled || stage.kind === 'confirm' || stage.kind === 'pairing');

  // The fragment carries a single-use secret. It is in this screen's state from
  // the first render, so the address bar — history, a bookmark, a screenshot,
  // the share sheet — has no further reason to hold it.
  useEffect(() => {
    if (arrival.kind !== 'none') onArrivalTaken?.();
  }, [arrival.kind, onArrivalTaken]);

  const revealPaste = useCallback(() => setPasting(true), []);

  const readText = useCallback((text: string): void => {
    try {
      setStage({ kind: 'confirm', seed: pairingSeedFromUrl(text.trim()) });
    } catch {
      setStage({ kind: 'failed', message: 'That is not a Ferretry pairing link.', cause: 'transport' });
    }
  }, []);

  const submitLink = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLinkError(null);
    let seed: PairingSeed;
    try {
      seed = pairingSeedFromUrl(link.read().trim());
    } catch (reason) {
      setLinkError(reason instanceof Error ? reason.message : 'The pairing link could not be read.');
      return;
    }
    // Cleared before anything is awaited: the field must not still be holding a
    // single-use code while the network is in flight.
    link.clear();
    setStage({ kind: 'confirm', seed });
  };

  const pair = async (seed: PairingSeed, name: string, machine?: string): Promise<void> => {
    setStage({ kind: 'pairing', seed });
    try {
      const as = await onPair(seed, name, machine);
      setStage({
        kind: 'paired',
        path: describeDaemonPath({ address: seed.daemonUrl, name: as?.machine, via: as?.via, sameMachine }),
        ...(as?.connection === undefined ? {} : { connection: as.connection }),
      });
    } catch (reason) {
      setStage({
        kind: 'failed',
        message: reason instanceof Error ? reason.message : 'Could not pair with that daemon.',
        // A sealed refusal arrives as its own class from the exchange, which is the structural
        // distinction §14 asks for. Everything else — a rendezvous nobody holds, a busy one, a
        // network that went away mid-attempt — is transport, and a reader whose real problem is
        // their network must not be told to go and mint another code.
        cause: failureCause(reason),
      });
    }
  };

  const startOver = (): void => {
    setStage(BROWSE);
    setLinkError(null);
  };

  if (stage.kind !== 'browse') {
    return (
      <PairingFocus
        stage={stage}
        onPair={(seed, name, machine) => void pair(seed, name, machine)}
        deviceName={deviceName}
        onDeviceName={setDeviceName}
        machineName={machineName}
        onMachineName={setMachineName}
        onCancel={startOver}
        paired={connections.length > 0}
        embedded={embedded}
        sameMachine={sameMachine}
        passkeyClient={passkeyClient}
        passkeyOffer={passkeyOffer}
        onContinue={onContinue}
        afterPaired={afterPaired}
        onClose={onClose}
      />
    );
  }

  const first = connections.length === 0;
  return (
    <PairingFrame embedded={embedded} stage="browse" onClose={onClose} progress={first}>
      {!embedded && (
        <header className="min-w-0 text-center">
          <div className="flex items-center justify-center gap-2 text-accent">
            <BrandMark size={20} />
            <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
          </div>
          <h1 id="pairing-title" className="mb-1 mt-2 font-display text-display font-bold tracking-display text-fg">
            {first ? 'Connect a daemon' : 'Your daemons'}
          </h1>
          <p className="m-0 text-ui leading-base text-muted">
            {first ? (
              <>
                Run <code className="font-mono text-fg">fy pair</code> on your computer, then scan its code, upload a
                picture of it, or paste its link.
              </>
            ) : (
              'Choose where this tab works. Each daemon keeps separate data.'
            )}
          </p>
        </header>
      )}

      {connections.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Paired daemons">
          {connections.map(connection => {
            const selected = connection.daemonId === selectedDaemonId;
            // A list row never claims a path: it names the daemon, and shows its address only when that is not loopback.
            const listed = describeListedDaemon({
              address: connection.baseUrl,
              name: connection.daemonName,
            });
            const name = listed.title;
            return (
              <li
                key={connection.daemonId}
                className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-control border border-border bg-surface-2 px-control-x py-2"
              >
                <button
                  type="button"
                  className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-left hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => onSelect(connection.daemonId)}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong text-transparent'}`}
                    aria-hidden="true"
                  >
                    <Check size={13} strokeWidth={3} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-ui font-semibold text-fg">{name}</span>
                    {listed.address !== undefined && listed.address !== name && (
                      <span className="block truncate font-mono text-meta text-faint">{listed.address}</span>
                    )}
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-faint" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="min-h-[44px] rounded-control px-2 text-ui font-semibold text-warn hover:bg-warn-bg focus-visible:outline-focus focus-visible:outline-offset-focus"
                  aria-label={`Forget ${name}`}
                  onClick={() => onRemove(connection.daemonId)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  <span className="sr-only">Forget</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <PairScanner
        host={scanHost}
        pasteOpen={pasting || scanHost === null}
        onPaste={revealPaste}
        typedRevision={link.revision}
        {...(readImage === undefined ? {} : { readImage })}
        onText={readText}
        onFailed={revealPaste}
      />

      {pasting || scanHost === null ? (
        <form className="flex flex-col gap-2" onSubmit={submitLink}>
          <label className="flex flex-col gap-1 text-ui font-medium text-fg" htmlFor="pairing-link">
            Pairing link
            <SecretInput
              field={link}
              id="pairing-link"
              aria-label="Pairing link"
              aria-describedby="pairing-link-error"
              className="h-control min-h-[44px] w-full rounded-control border border-border bg-surface-2 px-control-x font-mono text-meta text-fg placeholder:text-faint focus:border-accent"
              placeholder="https://…/pair#…"
            />
          </label>
          {linkError !== null && (
            <p id="pairing-link-error" className="m-0 text-ui text-err" role="alert">
              {linkError}
            </p>
          )}
          <ActionRow
            primary={
              <PairButton type="submit" disabled={!link.filled}>
                <Link2 size={16} aria-hidden="true" />
                Use this link
              </PairButton>
            }
          />
        </form>
      ) : null}

      {/*
        Quiet on purpose. Someone with a working pairing is here to choose a
        daemon; setting up another machine is a real errand but not this
        screen's errand, so it is a link at the end rather than a second hero.
      */}
      {onOpenSetup !== undefined && (
        <button
          type="button"
          className="min-h-[44px] self-center text-ui font-medium text-muted underline hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
          onClick={onOpenSetup}
          data-pairing-setup=""
        >
          Set up another machine
        </button>
      )}

      <HowThisWorks />
    </PairingFrame>
  );
}

interface PairingFrameProps {
  readonly embedded: boolean;
  /**
   * Where the reader is, as a machine-readable value on the housing.
   *
   * FOR TESTS AND FOR HARNESSES, NOT FOR STYLING. The compiled-binary browser proof has to know that
   * a pairing SUCCEEDED — as durable product state, not a toast that disappears before an assertion
   * can see it — and matching on copy or a class name makes every rewording a broken harness. One
   * attribute, one vocabulary, and it is the `Stage` union's own `kind` so the two cannot drift.
   */
  readonly stage: Stage['kind'];
  /**
   * What a screen reader should hear about the stage. ONE live region lives in the housing for the whole arc, because a
   * region that is mounted together with its text is often not announced at all.
   */
  readonly announce?: string;
  /** Where the Back control goes; none is drawn when absent, embedded, or on the success screen. */
  readonly onClose?: (() => void) | undefined;
  /** False on "Your daemons" (a list of what is already paired is not step 1 of a run); every other stage draws the bar. */
  readonly progress?: boolean;
  readonly children: ReactNode;
}

/** The mascot's pose for each stage; a failed pairing has no mascot (nothing to cheer, and nothing to mock). */
const POSE: Readonly<Record<Stage['kind'], FerretPose | undefined>> = {
  browse: 'peek',
  confirm: 'peek',
  pairing: 'curious',
  paired: 'cheer',
  failed: undefined,
};

/** A line the walk numbered ("1. Check…"), and what follows the number. */
const NUMBERED_LINE = /^\d+\.\s+(.*)$/;

type MessageBlock =
  | { readonly kind: 'line'; readonly text: string }
  | { readonly kind: 'steps'; readonly steps: readonly string[] };

/**
 * A failure message's lines, with each run of numbered lines gathered into one list.
 * The pairing walk writes "what was tried" lines, then "Most likely fix:" and numbered lines;
 * a message without numbered lines (every other failure) is one block per line, as before.
 */
const messageBlocks = (message: string): readonly MessageBlock[] => {
  const blocks: MessageBlock[] = [];
  for (const line of message.split('\n')) {
    const numbered = NUMBERED_LINE.exec(line);
    const last = blocks[blocks.length - 1];
    if (numbered?.[1] === undefined) {
      if (line.trim().length > 0) blocks.push({ kind: 'line', text: line });
    } else if (last?.kind === 'steps') {
      blocks[blocks.length - 1] = { kind: 'steps', steps: [...last.steps, numbered[1]] };
    } else {
      blocks.push({ kind: 'steps', steps: [numbered[1]] });
    }
  }
  return blocks;
};

/** The failure sentence(s), short lines and a real numbered list when the walk gave one. */
function FailureMessage({ message, cause }: { readonly message: string; readonly cause: PairingFailureCause }) {
  return (
    <div className="m-0 flex flex-col gap-2 text-ui leading-base text-err" role="alert" data-pairing-failure={cause}>
      {messageBlocks(message).map(block =>
        block.kind === 'steps' ? (
          <ol key={block.steps.join('\n')} className="m-0 flex list-decimal flex-col gap-1 pl-5">
            {block.steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : (
          <p key={block.text} className="m-0">
            {block.text}
          </p>
        ),
      )}
    </div>
  );
}

/** The housing, and the only thing the embedded seam actually changes. */
function PairingFrame({ embedded, stage, announce = '', onClose, progress = true, children }: PairingFrameProps) {
  const status = (
    <p className="sr-only" role="status">
      {announce}
    </p>
  );
  if (embedded) {
    return (
      <section className={EMBEDDED_SHELL} aria-label="Pair this device" data-pairing-stage={stage}>
        {children}
        {status}
      </section>
    );
  }
  const pose = POSE[stage];
  return (
    <div className="fy-pair-scene flex flex-col">
      <PairingSky celebrating={stage === 'paired'} />
      <main className={SHELL} aria-labelledby="pairing-title" data-pairing-stage={stage}>
        {onClose !== undefined && stage !== 'paired' && <PairingBack onClose={onClose} />}
        {progress && <PairProgress stage={stage} />}
        {pose !== undefined && (
          <div className="fy-pair-hero">
            <FerretMascot pose={pose} />
            {stage === 'paired' && (
              <span className="fy-pair-badge" aria-hidden="true">
                <Check size={22} strokeWidth={3} />
              </span>
            )}
          </div>
        )}
        {children}
        {status}
      </main>
    </div>
  );
}

/** No page spacing, no max width, no safe-area padding: the host owns all three. */
const EMBEDDED_SHELL = 'flex min-w-0 flex-col gap-4';

const SHELL =
  'mx-auto flex min-h-full flex-1 w-full max-w-[600px] flex-col gap-4 py-6 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-10';

/**
 * The security explanation, below the fold and behind one tap.
 *
 * It is true and it matters — but a first-time reader on a phone needs the
 * button, and someone who wants to know why this is safe will look for it.
 */
function HowThisWorks() {
  return (
    <details className="mt-2 rounded-control border border-border bg-surface-2 px-control-x py-2">
      <summary className="min-h-[44px] cursor-pointer list-none py-2 text-ui font-medium text-muted marker:content-none">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck size={16} aria-hidden="true" />
          How this works
        </span>
      </summary>
      <p className="m-0 pb-2 text-meta leading-base text-muted">
        Ferretry runs on your own machine. This page ships with no daemon address and no credentials — both arrive from
        the pairing link at runtime. The code in that link is single-use, expires about two minutes after{' '}
        <code className="font-mono">fy pair</code> prints it, and travels in the URL fragment, which browsers never send
        to a server.
      </p>
    </details>
  );
}

interface PairingFocusProps {
  readonly stage: Exclude<Stage, { kind: 'browse' }>;
  readonly onPair: (seed: PairingSeed, deviceName: string, machineName?: string) => void;
  /** What the person is calling the machine; empty keeps its host name until the later step offers one. */
  readonly machineName: string;
  readonly onMachineName: (name: string) => void;
  readonly onCancel: () => void;
  /** What this device will be called at the machine, as the person has it in the field. */
  readonly deviceName: string;
  readonly onDeviceName: (name: string) => void;
  /** Whether anything is paired yet, so the cancel control names the right place. */
  readonly paired: boolean;
  readonly embedded: boolean;
  readonly sameMachine: boolean;
  readonly passkeyClient: FirstPasskeyClientFactory | undefined;
  readonly passkeyOffer: PairingScreenProps['passkeyOffer'];
  readonly onContinue: (() => void) | undefined;
  readonly afterPaired?: ReactNode;
  readonly onClose: (() => void) | undefined;
}

/**
 * The single-decision screen: which daemon, and one button.
 *
 * Deliberately not the browse screen with a banner on top. A reader who arrived
 * from a QR has exactly one thing to decide, and every other control on the
 * page is a way to get that wrong.
 */
function PairingFocus({
  stage,
  onPair,
  onCancel,
  paired,
  embedded,
  deviceName,
  onDeviceName,
  machineName,
  onMachineName,
  sameMachine,
  passkeyClient,
  passkeyOffer,
  onContinue,
  afterPaired,
  onClose,
}: PairingFocusProps) {
  // Whether the name is being edited. Above every early return: hooks run in the same order each render.
  const [renaming, setRenaming] = useState(false);
  // After a success the heading takes focus: the button that was pressed is gone, and a keyboard or screen-reader
  // reader would otherwise be left on nothing. It is the heading, not a control, so nothing becomes a tab stop.
  const doneTitle = useRef<HTMLHeadingElement>(null);
  const done = stage.kind === 'paired';
  useEffect(() => {
    if (done) doneTitle.current?.focus({ preventScroll: true });
  }, [done]);
  /*
   * Headings step DOWN when embedded, they do not repeat.
   * The setup stepper's stage heading is the `<h2>` above this component, so a
   * confirmation titled `<h2>` here would read as a sibling of the stage rather
   * than as part of it — and a second `<h1>` would be an outline bug outright.
   */
  const Title = embedded ? 'h3' : 'h1';
  const titleClass = embedded
    ? 'm-0 font-display text-title font-bold tracking-display text-fg'
    : 'm-0 font-display text-display font-bold tracking-display text-fg';
  if (stage.kind === 'paired') {
    return (
      <PairingFrame
        embedded={embedded}
        stage="paired"
        announce={`Connected. Paired with ${stage.path.title}, ${stage.path.path}.`}
      >
        <div className="fy-pair-arrive flex flex-col items-center gap-2 pb-8 text-center sm:items-start sm:text-left">
          <Title id="pairing-title" ref={doneTitle} tabIndex={-1} className={`${titleClass} outline-none`}>
            Connected
          </Title>
          {/* ONE heading and ONE supporting line, both centred. How it connected (relay or direct) is a detail, behind a tap. */}
          <LineWithDetails
            lineProps={{ 'data-paired-with': '' }}
            detailsProps={{ 'data-paired-details': '' }}
            details={<>Connection: {stage.path.path}.</>}
          >
            Paired with <span className="font-semibold">{stage.path.title}</span>.
          </LineWithDetails>
          {onContinue !== undefined ? (
            <PairedNext
              connection={stage.connection}
              createClient={passkeyClient}
              offer={passkeyOffer}
              onContinue={onContinue}
            />
          ) : stage.connection === undefined || passkeyClient === undefined ? null : (
            <FirstPasskeyOffer {...passkeyOffer} connection={stage.connection} createClient={passkeyClient} />
          )}
          {afterPaired}
        </div>
      </PairingFrame>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <PairingFrame embedded={embedded} stage="failed" onClose={onClose}>
        <Title id="pairing-title" className={titleClass}>
          Pairing failed
        </Title>
        <FailureMessage message={stage.message} cause={stage.cause} />
        {/*
          ONE REMEDY PER REASON, which is this repository's doctrine and here it is also §14's.
          A daemon that judged the code wants a fresh code; a redemption that never reached one wants
          the reader to look at their network, and telling them to mint again would send them to redo
          the only step that was working.
        */}
        {stage.cause !== 'stated' && (
          <p className="m-0 text-meta leading-base text-muted">
            {stage.cause === 'refusal' ? (
              <>
                Pairing codes are single-use and short-lived. Run <code className="font-mono">fy pair</code> again for a
                fresh one.
              </>
            ) : (
              <>
                Nothing reached that daemon, so its code is probably still good. Check that the machine is awake and on
                a network this device can reach, then try the same link again.
              </>
            )}
          </p>
        )}
        <ActionRow
          primary={
            <PairButton type="button" data-variant="primary" onClick={onCancel}>
              {paired ? 'Back to my daemons' : 'Start over'}
            </PairButton>
          }
        />
      </PairingFrame>
    );
  }

  const { seed } = stage;
  const target = describeDaemonPath({ address: seed.daemonUrl, sameMachine });
  const busy = stage.kind === 'pairing';
  const sendableName = normalizedDeviceName(deviceName);
  return (
    <PairingFrame
      embedded={embedded}
      stage={stage.kind}
      onClose={onClose}
      announce={busy ? 'Exchanging the one-time code with this daemon…' : ''}
    >
      <header className={embedded ? 'min-w-0' : 'min-w-0 text-center sm:text-left'}>
        {!embedded && (
          <div className="mb-2 flex items-center justify-center gap-2 text-accent sm:justify-start">
            <BrandMark size={20} />
            <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
          </div>
        )}
        <Title id="pairing-title" className={titleClass}>
          Pair this device?
        </Title>
      </header>

      {/*
        ONE FRIENDLY LINE, NOT A CARD (C59 O8-1). The card said "This machine / through the relay / Its name shows once paired": a link
        carries no name, so it was the same words every time and took the height of a panel. Now it is one sentence, and the machine's
        fingerprint (and its address, only when direct) sits behind a small link on the end of it.
      */}
      <LineWithDetails
        lineProps={{ 'data-daemon-path': target.kind }}
        detailsProps={{ 'data-pair-fingerprint': '' }}
        details={
          <>
            <span className="sr-only">Daemon fingerprint: </span>
            <span className="font-mono">{seed.daemonId}</span>
          </>
        }
      >
        {target.address === undefined ? (
          <>Pairing with this computer {target.path}.</>
        ) : (
          <>
            Pairing directly with <span className="break-all font-mono font-semibold">{target.address}</span>.
          </>
        )}
      </LineWithDetails>

      <DeviceNameLine
        name={deviceName}
        renaming={renaming}
        busy={busy}
        onName={onDeviceName}
        onRename={() => setRenaming(true)}
      />

      <MachineNameField value={machineName} disabled={busy} onChange={onMachineName} />

      {busy && <p className="m-0 text-center text-ui text-muted">Exchanging the one-time code with this daemon…</p>}
      <ConfirmActions
        busy={busy}
        pairDisabled={sendableName === undefined || machineNameChoice(machineName).kind === 'refused'}
        onCancel={onCancel}
        onPair={() => {
          const machine = machineNameChoice(machineName);
          if (sendableName === undefined || machine.kind === 'refused') return;
          if (machine.kind === 'none') onPair(seed, sendableName);
          else onPair(seed, sendableName, machine.name);
        }}
      />
    </PairingFrame>
  );
}
