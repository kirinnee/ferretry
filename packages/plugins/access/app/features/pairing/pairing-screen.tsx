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
import { SecretInput, useSecretField } from '@ferretry/app/ui';
import { Check, ChevronRight, Link2, ShieldCheck, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { type DaemonPath, describeDaemonPath } from '@ferretry/plugin-connections/contract';
import { PAIRING_DEVICE_NAME_MAX_LENGTH } from '../../../contract/index.ts';
import {
  BrandMark,
  type DaemonConnectionRecord,
  type DaemonId,
  daemonDisplayName,
  RelayPairingRefusedError,
} from '../../shell-pairing.ts';
import type { QrScanHost } from '../../lib/pair-scan.ts';
import { usePairingScreenMarker } from '../../lib/pairing-screen-marker.ts';
import { type PairingArrival, pairingSeedFromUrl, type PairingSeed } from '../../lib/pairing.ts';
import { DeviceKeyUnsupportedError } from '../../lib/device-keys.ts';
import { browserDeviceName } from '@ferretry/app';
import { normalizedDeviceName } from '../../lib/device-name.ts';
import { PairScanner } from './pair-scanner.tsx';

/** What the exchange learned, so the screen can say how it got there. Both parts are optional: a host may know neither. */
interface PairedAs {
  /** What the daemon calls its machine. */
  readonly machine?: string;
  /** Which path carried the exchange. */
  readonly via?: 'direct' | 'relay';
}

/** Exchanges the code; `deviceName` is what the person called this device on the confirm screen. */
type PairingExchange = (seed: PairingSeed, deviceName: string) => Promise<PairedAs | void>;

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
  | { readonly kind: 'paired'; readonly path: DaemonPath }
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
  onPair,
  onSelect,
  onRemove,
  onArrivalTaken,
  onOpenSetup,
  embedded = false,
  defaultName = browserDeviceName,
  onStatedFailure,
  sameMachine = pageIsLocal(),
}: PairingScreenProps) {
  const [stage, setStage] = useState<Stage>(() => initialStage(arrival));
  const statedFailure = stage.kind === 'failed' && stage.cause === 'stated';
  useEffect(() => {
    onStatedFailure?.(statedFailure);
  }, [onStatedFailure, statedFailure]);
  // Chosen once per screen, so a person editing it is never overwritten and two attempts send one name.
  const [deviceName, setDeviceName] = useState(defaultName);
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

  const pair = async (seed: PairingSeed, name: string): Promise<void> => {
    setStage({ kind: 'pairing', seed });
    try {
      const as = await onPair(seed, name);
      setStage({
        kind: 'paired',
        path: describeDaemonPath({ address: seed.daemonUrl, name: as?.machine, via: as?.via, sameMachine }),
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
        onPair={(seed, name) => void pair(seed, name)}
        deviceName={deviceName}
        onDeviceName={setDeviceName}
        onCancel={startOver}
        paired={connections.length > 0}
        embedded={embedded}
        sameMachine={sameMachine}
      />
    );
  }

  const first = connections.length === 0;
  return (
    <PairingFrame embedded={embedded} stage="browse">
      {!embedded && (
        <header className="min-w-0">
          <div className="flex items-center gap-2 text-accent">
            <BrandMark size={20} />
            <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
          </div>
          <h1 id="pairing-title" className="mb-1 mt-2 font-display text-display font-bold tracking-display text-fg">
            {first ? 'Connect a daemon' : 'Your daemons'}
          </h1>
          <p className="m-0 text-ui leading-base text-muted">
            {first ? (
              <>
                Run <code className="font-mono text-fg">fy pair</code> on your computer, then scan the code.
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
            // A relayed daemon is its name and "through the relay", never the loopback address it listens on.
            const path = describeDaemonPath({
              address: connection.baseUrl,
              name: connection.label?.trim() || connection.daemonName,
              sameMachine,
            });
            // A direct daemon keeps the name it always had, with its address beneath.
            const name = path.kind === 'relay' ? path.title : daemonDisplayName(connection);
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
                    <span className="block truncate font-mono text-meta text-faint" data-daemon-path={path.kind}>
                      {path.kind === 'relay' || name === connection.baseUrl
                        ? path.path
                        : `${path.path} · ${connection.baseUrl}`}
                    </span>
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
        label={first ? 'Scan QR code' : 'Pair another daemon'}
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
              className="h-control w-full rounded-control border border-border bg-surface-2 px-control-x font-mono text-meta text-fg placeholder:text-faint focus:border-accent"
              placeholder="https://…/pair#…"
            />
          </label>
          {linkError !== null && (
            <p id="pairing-link-error" className="m-0 text-ui text-err" role="alert">
              {linkError}
            </p>
          )}
          <button type="submit" className="kt-btn min-h-[44px]" disabled={!link.filled}>
            <Link2 size={16} aria-hidden="true" />
            Use this link
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="min-h-[44px] self-center text-ui font-medium text-muted underline hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
          onClick={revealPaste}
        >
          Paste a link instead
        </button>
      )}

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
  readonly children: ReactNode;
}

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
function PairingFrame({ embedded, stage, children }: PairingFrameProps) {
  if (embedded) {
    return (
      <section className={EMBEDDED_SHELL} aria-label="Pair this device" data-pairing-stage={stage}>
        {children}
      </section>
    );
  }
  return (
    <main className={SHELL} aria-labelledby="pairing-title" data-pairing-stage={stage}>
      {children}
    </main>
  );
}

/** No page spacing, no max width, no safe-area padding: the host owns all three. */
const EMBEDDED_SHELL = 'flex min-w-0 flex-col gap-4';

const SHELL =
  'mx-auto flex min-h-full w-full max-w-[520px] flex-col gap-4 py-6 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-10';

/**
 * The security explanation, below the fold and behind one tap.
 *
 * It is true and it matters — but a first-time reader on a phone needs the
 * button, and someone who wants to know why this is safe will look for it.
 */
function HowThisWorks() {
  return (
    <details className="mt-auto rounded-control border border-border bg-surface-2 px-control-x py-2">
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
  readonly onPair: (seed: PairingSeed, deviceName: string) => void;
  readonly onCancel: () => void;
  /** What this device will be called at the machine, as the person has it in the field. */
  readonly deviceName: string;
  readonly onDeviceName: (name: string) => void;
  /** Whether anything is paired yet, so the cancel control names the right place. */
  readonly paired: boolean;
  readonly embedded: boolean;
  readonly sameMachine: boolean;
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
  sameMachine,
}: PairingFocusProps) {
  // Whether the name is being edited. Above every early return: hooks run in the same order each render.
  const [renaming, setRenaming] = useState(false);
  /*
   * Headings step DOWN when embedded, they do not repeat.
   * The setup stepper's stage heading is the `<h2>` above this component, so a
   * confirmation titled `<h2>` here would read as a sibling of the stage rather
   * than as part of it — and a second `<h1>` would be an outline bug outright.
   */
  const Title = embedded ? 'h3' : 'h1';
  const TargetTitle = embedded ? 'h3' : 'h2';
  const titleClass = embedded
    ? 'm-0 font-display text-title font-bold tracking-display text-fg'
    : 'm-0 font-display text-display font-bold tracking-display text-fg';
  if (stage.kind === 'paired') {
    return (
      <PairingFrame embedded={embedded} stage="paired">
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span
            className="flex h-16 w-16 items-center justify-center rounded-full border-heavy border-ok bg-ok-bg text-ok"
            aria-hidden="true"
          >
            <Check size={34} strokeWidth={3} />
          </span>
          <Title id="pairing-title" className={titleClass}>
            Connected
          </Title>
          <p className="m-0 text-ui leading-base text-muted" role="status">
            Paired with <span className="font-semibold text-fg">{stage.path.title}</span>, {stage.path.path}.
          </p>
        </div>
      </PairingFrame>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <PairingFrame embedded={embedded} stage="failed">
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
        <button
          type="button"
          className="kt-btn min-h-[56px] w-full text-title"
          data-variant="primary"
          onClick={onCancel}
        >
          {paired ? 'Back to my daemons' : 'Start over'}
        </button>
      </PairingFrame>
    );
  }

  const { seed } = stage;
  const target = describeDaemonPath({ address: seed.daemonUrl, sameMachine });
  const busy = stage.kind === 'pairing';
  const sendableName = normalizedDeviceName(deviceName);
  return (
    <PairingFrame embedded={embedded} stage={stage.kind}>
      <header className="min-w-0">
        {!embedded && (
          <div className="mb-2 flex items-center gap-2 text-accent">
            <BrandMark size={20} />
            <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
          </div>
        )}
        <Title id="pairing-title" className={titleClass}>
          Pair this device?
        </Title>
      </header>

      <section className="kt-panel p-panel" aria-labelledby="pairing-target">
        <TargetTitle id="pairing-target" className="sr-only">
          The daemon this link points at
        </TargetTitle>
        {/* A link carries no machine name, only an address: say HOW it will be reached, and show the address only when that is direct. */}
        <p className="m-0 break-all text-title font-semibold text-fg" data-daemon-path={target.kind}>
          {target.address === undefined ? target.title : <span className="font-mono">{target.address}</span>}
        </p>
        <p className="m-0 mt-1 text-ui text-muted">{target.address === undefined ? target.path : 'direct'}</p>
        <details className="mt-2" data-pair-details="">
          <summary className="min-h-[44px] cursor-pointer text-ui font-medium text-muted hover:text-accent">
            Details
          </summary>
          <p className="m-0 break-all font-mono text-meta text-faint">
            <span className="sr-only">Daemon fingerprint: </span>
            {seed.daemonId}
          </p>
        </details>
      </section>

      {/*
        WHAT THE MACHINE WILL CALL THIS DEVICE, said before it is sent, and changeable. Every browser
        used to pair as "Ferretry PWA", and a second one made every name at the machine ambiguous; the
        default is now this browser and system plus a short suffix. A sentence with a quiet Rename
        rather than a field, because this screen is still one decision for somebody who scanned a QR.
      */}
      {renaming ? (
        <label className="flex min-w-0 flex-col gap-1 text-ui text-muted">
          Name this device
          <input
            type="text"
            className="kt-input min-h-[44px] min-w-0"
            data-pair-device-name=""
            value={deviceName}
            maxLength={PAIRING_DEVICE_NAME_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={event => onDeviceName(event.target.value)}
          />
        </label>
      ) : (
        <p className="m-0 min-w-0 break-words text-ui leading-base text-muted" data-pair-device-label="">
          This device will be called <span className="font-semibold text-fg">{deviceName}</span>.{' '}
          <button
            type="button"
            className="min-h-[44px] bg-transparent p-0 font-medium text-accent underline"
            data-pair-device-rename=""
            onClick={() => setRenaming(true)}
            disabled={busy}
          >
            Rename
          </button>
        </p>
      )}

      {/*
        `data-pair-confirm` names the one control that starts a redemption, so a harness presses it
        by identity rather than by position or by a design-system attribute. Both fallbacks are
        wrong for the same reason in different ways: the first structural button on this screen is a
        NAVIGATION control, and `data-variant="primary"` is a styling choice a restyle may take away
        while leaving a journey silently pressing nothing.
      */}
      <button
        type="button"
        className="kt-btn min-h-[64px] w-full text-title"
        data-variant="primary"
        data-pair-confirm=""
        onClick={() => {
          if (sendableName !== undefined) onPair(seed, sendableName);
        }}
        disabled={busy || sendableName === undefined}
      >
        {busy ? 'Pairing…' : 'Pair this device'}
      </button>
      <p className={busy ? 'm-0 text-center text-ui text-muted' : 'sr-only'} role="status">
        {busy ? 'Exchanging the one-time code with this daemon…' : ''}
      </p>
      <button
        type="button"
        className="min-h-[44px] self-center text-ui font-medium text-muted underline hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
        onClick={onCancel}
        disabled={busy}
      >
        Not now
      </button>
    </PairingFrame>
  );
}
