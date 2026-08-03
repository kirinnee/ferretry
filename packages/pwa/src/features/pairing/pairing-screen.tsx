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
 * terminal and on a loopback page, and the QR encodes a link to `/pair#v1;…`.
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
import { Check, ChevronRight, Link2, ShieldCheck, Trash2 } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';

import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { QrScanHost } from '../../lib/pair-scan.ts';
import { type PairingArrival, pairingDaemonHost, pairingSeedFromUrl, type PairingSeed } from '../../lib/pairing.ts';
import { BrandMark } from '../../shell/brand-mark.tsx';
import { PairScanner } from './pair-scanner.tsx';

export type PairingExchange = (seed: PairingSeed) => Promise<void>;

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
  readonly onSelect: (daemonId: DaemonId) => void;
  readonly onRemove: (daemonId: DaemonId) => void;
  /**
   * The arrival's single-use code has been taken into this screen's state and
   * should now leave the address bar. Called once, on first render.
   */
  readonly onArrivalTaken?: () => void;
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
  | { readonly kind: 'paired'; readonly host: string }
  | { readonly kind: 'failed'; readonly message: string };

const BROWSE: Stage = { kind: 'browse' };

const connectionName = (connection: DaemonConnectionRecord): string => connection.label ?? String(connection.daemonId);

/** The stage a fresh mount starts in, decided entirely by how the tab was opened. */
const initialStage = (arrival: PairingArrival): Stage => {
  if (arrival.kind === 'seed') return { kind: 'confirm', seed: arrival.seed };
  if (arrival.kind === 'unreadable')
    return { kind: 'failed', message: `This pairing link is damaged: ${arrival.reason}.` };
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
}: PairingScreenProps) {
  const [stage, setStage] = useState<Stage>(() => initialStage(arrival));
  const [pasting, setPasting] = useState(false);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);

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
      setStage({ kind: 'failed', message: 'That is not a Ferretry pairing link.' });
    }
  }, []);

  const submitLink = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setLinkError(null);
    let seed: PairingSeed;
    try {
      seed = pairingSeedFromUrl(link.trim());
    } catch (reason) {
      setLinkError(reason instanceof Error ? reason.message : 'The pairing link could not be read.');
      return;
    }
    // Cleared before anything is awaited: the field must not still be holding a
    // single-use code while the network is in flight.
    setLink('');
    setStage({ kind: 'confirm', seed });
  };

  const pair = async (seed: PairingSeed): Promise<void> => {
    setStage({ kind: 'pairing', seed });
    try {
      await onPair(seed);
      setStage({ kind: 'paired', host: pairingDaemonHost(seed) });
    } catch (reason) {
      setStage({
        kind: 'failed',
        message: reason instanceof Error ? reason.message : 'Could not pair with that daemon.',
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
        onPair={seed => void pair(seed)}
        onCancel={startOver}
        paired={connections.length > 0}
        embedded={embedded}
      />
    );
  }

  const first = connections.length === 0;
  return (
    <PairingFrame embedded={embedded}>
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
            const name = connectionName(connection);
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
                    <span className="block truncate font-mono text-meta text-faint">{connection.baseUrl}</span>
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
            <input
              id="pairing-link"
              aria-label="Pairing link"
              aria-describedby="pairing-link-error"
              autoCapitalize="none"
              autoComplete="off"
              className="h-control w-full rounded-control border border-border bg-surface-2 px-control-x font-mono text-meta text-fg placeholder:text-faint focus:border-accent"
              onChange={event => setLink(event.target.value)}
              placeholder="https://…/pair#v1;…"
              spellCheck={false}
              value={link}
            />
          </label>
          {linkError !== null && (
            <p id="pairing-link-error" className="m-0 text-ui text-err" role="alert">
              {linkError}
            </p>
          )}
          <button type="submit" className="kt-btn min-h-[44px]" disabled={link.trim() === ''}>
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
  readonly children: ReactNode;
}

/** The housing, and the only thing the embedded seam actually changes. */
function PairingFrame({ embedded, children }: PairingFrameProps) {
  if (embedded) {
    return (
      <section className={EMBEDDED_SHELL} aria-label="Pair this device">
        {children}
      </section>
    );
  }
  return (
    <main className={SHELL} aria-labelledby="pairing-title">
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
  readonly onPair: (seed: PairingSeed) => void;
  readonly onCancel: () => void;
  /** Whether anything is paired yet, so the cancel control names the right place. */
  readonly paired: boolean;
  readonly embedded: boolean;
}

/**
 * The single-decision screen: which daemon, and one button.
 *
 * Deliberately not the browse screen with a banner on top. A reader who arrived
 * from a QR has exactly one thing to decide, and every other control on the
 * page is a way to get that wrong.
 */
function PairingFocus({ stage, onPair, onCancel, paired, embedded }: PairingFocusProps) {
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
      <PairingFrame embedded={embedded}>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <span
            className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-ok bg-ok-bg text-ok"
            aria-hidden="true"
          >
            <Check size={34} strokeWidth={3} />
          </span>
          <Title id="pairing-title" className={titleClass}>
            Connected
          </Title>
          <p className="m-0 text-ui leading-base text-muted" role="status">
            Paired with <span className="font-mono text-fg">{stage.host}</span>.
          </p>
        </div>
      </PairingFrame>
    );
  }

  if (stage.kind === 'failed') {
    return (
      <PairingFrame embedded={embedded}>
        <Title id="pairing-title" className={titleClass}>
          Pairing failed
        </Title>
        <p className="m-0 text-ui leading-base text-err" role="alert">
          {stage.message}
        </p>
        <p className="m-0 text-meta leading-base text-muted">
          Pairing codes are single-use and short-lived. Run <code className="font-mono">fy pair</code> again for a fresh
          one.
        </p>
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
  const busy = stage.kind === 'pairing';
  return (
    <PairingFrame embedded={embedded}>
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
        <p className="m-0 break-all font-mono text-title font-semibold text-fg">{pairingDaemonHost(seed)}</p>
        <p className="m-0 mt-1 break-all font-mono text-meta text-faint">
          <span className="sr-only">Daemon fingerprint: </span>
          {seed.daemonId}
        </p>
      </section>

      <button
        type="button"
        className="kt-btn min-h-[64px] w-full text-title"
        data-variant="primary"
        onClick={() => onPair(seed)}
        disabled={busy}
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
