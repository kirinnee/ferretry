/**
 * THE STAGES: heading, one command, one action.
 *
 * Each stage used to carry its command plus two or three paragraphs explaining
 * the command, and the paragraphs are what made the screen unreadable — they sat
 * at the same weight as the thing to actually do, so the next action had to be
 * hunted for. The rule now is that a stage shows exactly what a reader must run
 * and nothing else; everything that answers "why" or "what if" moves behind a
 * disclosure, one tap away, closed by default.
 *
 * NOTHING HONEST WAS DROPPED to get there. The verification command, the healthy
 * daemon's output and the two-minute expiry are all still on the page — they are
 * simply no longer competing with the instruction. What was cut is restatement.
 *
 * THE AGENT PATH IS NOT A STAGE ANNEXE ANY MORE. It used to hide in an install
 * aside labelled "Check it, or let an agent do it", which put an entire
 * alternative journey behind the same disclosure as a version check. It is now a
 * route of its own with its own step, `BriefStage`, and the install aside is back
 * to being what it says: how to check.
 *
 * EVERY STAGE HERE IS REUSED BY EVERY ROUTE THAT NEEDS IT, including "set up
 * another machine" — a second copy of the daemon instructions is a second copy to
 * keep true, and one of the two would be wrong within a release.
 */

import { ExternalLink } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CommandBlock } from './command-block.tsx';
import { type ClipboardWriter, CopyButton } from './copy-button.tsx';
import {
  CARRIER_ORDER_NOTE,
  HOSTED_RELAY_DISABLED_NOTE,
  HOSTED_RELAY_DISCLOSURE,
  HOSTED_RELAY_UNDETERMINED_NOTE,
  type HostedRelayFallback,
  TRANSPORT_NOT_WIRED_NOTE,
} from './hosted-relay.ts';
import {
  AGENT_SETUP_PROMPT,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  PAIR_COMMAND,
  VERIFY_COMMAND,
} from './onboarding-model.ts';

const STAGE = 'flex min-w-0 flex-col gap-2';

const CHOICE =
  'min-h-[36px] rounded-control border px-2 text-meta focus-visible:outline-focus focus-visible:outline-offset-focus';

const CHOICE_TONE = {
  on: 'border-accent bg-accent-bg font-semibold text-fg',
  off: 'border-border bg-surface-2 text-muted',
} as const;

/**
 * A secondary thing, folded away.
 *
 * `<details>` rather than a toggle we own: it is closed by default, it opens on
 * one tap, it is keyboard operable and findable by browser search for free, and
 * its native marker is a shape a reader recognises without reading the label.
 */
function Aside({ summary, children }: { readonly summary: string; readonly children: ReactNode }) {
  return (
    <details
      className="min-w-0 rounded-control border border-border bg-surface-2 px-2 py-1"
      data-onboarding-aside={summary}
    >
      <summary className="cursor-pointer text-meta text-muted focus-visible:outline-focus focus-visible:outline-offset-focus">
        {summary}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 pb-1">{children}</div>
    </details>
  );
}

export function InstallStage({
  write,
  channel,
}: {
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
}) {
  const [selected, setSelected] = useState<InstallChannelId>(channel);
  const chosen = installChannel(selected);
  return (
    <div className={STAGE}>
      {/*
        A row of buttons that swaps what is shown below it. `role="toolbar"`
        rather than a tablist: there is no tab panel per option, and rather than
        a bare labelled div, which is not a nameable element.

        A GRID, NOT A WRAPPING ROW. Labels of different widths wrap into a ragged
        last row, which reads as a mistake rather than a choice. The four NAMED
        routes take two even columns on a phone and one row on anything wider;
        the fallback spans the full width beneath them, which is both tidy and
        true — it is the route for machines the named ones do not cover.
      */}
      <div role="toolbar" aria-label="Install method" className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        {INSTALL_CHANNELS.map(option => (
          <button
            key={option.id}
            type="button"
            className={`${CHOICE} ${option.id === selected ? CHOICE_TONE.on : CHOICE_TONE.off} ${
              option.fallback === undefined ? '' : 'col-span-2 sm:col-span-4'
            }`}
            aria-pressed={option.id === selected}
            onClick={() => setSelected(option.id)}
            data-onboarding-channel={option.id}
          >
            {option.label}
          </button>
        ))}
      </div>

      <CommandBlock command={chosen.command} copyLabel="Copy install command" write={write} />

      {/*
        Said only for the fallback, and only when it is showing: a reader who
        picked `brew` does not need to be told what the script would have done,
        and a reader who landed on the script does need to know that a first-class
        route may exist for their machine.
      */}
      {chosen.fallback === undefined ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-onboarding-fallback-note="">
          The generic fallback. It works on every supported target — but if your machine is named above, that route is
          packaged and, on macOS, clears the Gatekeeper quarantine for you.
        </p>
      )}

      <Aside summary="Check it landed">
        <CommandBlock command={VERIFY_COMMAND} copyLabel="Copy check" write={write} />
      </Aside>
    </div>
  );
}

export function DaemonStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <CommandBlock command={DAEMON_START_COMMAND} copyLabel="Copy start command" write={write} />
      <Aside summary="Is it actually up?">
        <CommandBlock command={DAEMON_STATUS_COMMAND} copyLabel="Copy status command" write={write} />
        <p className="m-0 text-meta leading-base text-muted">
          A healthy daemon prints <code className="font-mono text-syn-string">{DAEMON_SERVING_OUTPUT}</code>.
        </p>
      </Aside>
      <Aside summary="Keep it running after a reboot">
        <CommandBlock command={DAEMON_INSTALL_COMMAND} copyLabel="Copy service command" write={write} />
        <p className="m-0 text-meta leading-base text-muted">
          Installs the user service and starts the daemon under it.
        </p>
      </Aside>
    </div>
  );
}

export interface ConnectStageProps {
  /**
   * What the runtime advertisement said about the fallback carrier.
   *
   * No clipboard seam any more: this step has no command to copy, because there
   * is nothing for the reader to run. That is the change, not an omission.
   */
  readonly fallback: HostedRelayFallback;
}

/**
 * HOW A BROWSER REACHES A DAEMON — reported, not chosen, and not overstated.
 *
 * This step used to be a three-way carrier chooser. It is not one any more,
 * because choosing is not what happens: a direct connection is what Ferretry uses
 * whenever the browser can reach the daemon, and the hosted relay exists to carry
 * the traffic when it cannot. A toggle asked the reader to decide something the
 * connection decides for itself, before there was a daemon to decide it about.
 *
 * IT DOES NOT CLAIM A FALLBACK THAT CANNOT HAPPEN. `packages/relay` is complete
 * and tested, and nothing mounts it: neither the daemon nor this browser dials a
 * relay yet. So `TRANSPORT_NOT_WIRED_NOTE` is on the glass, in the warning tone,
 * above everything else — a reader whose daemon is behind NAT needs to know that
 * TODAY, not to discover it when pairing succeeds and nothing connects.
 *
 * THE ADVERTISEMENT IS STILL READ AND STILL SHOWN, in four states that are not
 * each other: checking, available, switched off, and "this page does not know".
 * Production is in the last one and says why, because nothing tells this page
 * which origin serves the directory (`hosted-relay.ts` records what is missing).
 *
 * Running your own relay is supported by the protocol and documented in
 * `docs/relay-protocol.md`; it is deliberately NOT advertised here, because a
 * setup screen offering a Cloudflare deploy to somebody installing a CLI is a
 * fork in a road that has one sensible direction.
 *
 * WHAT THIS STEP CANNOT SAY is which carrier is ACTIVE. Nothing is connected yet,
 * this page has tested neither, and the live answer belongs to a transport that
 * does not exist. Saying so is the only honest option available to it.
 */
export function ConnectStage({ fallback }: ConnectStageProps) {
  return (
    <div className={STAGE} data-onboarding-fallback={fallback.kind}>
      <p className="m-0 text-meta leading-base text-fg">{CARRIER_ORDER_NOTE}</p>

      {/*
        FIRST, AND IN THE WARNING TONE. The gap is the most consequential thing
        on this step for the one reader it affects most: somebody whose daemon is
        behind NAT, who would otherwise pair successfully and connect to nothing.
      */}
      <p className="m-0 text-meta leading-base text-warn" data-onboarding-transport-gap="">
        {TRANSPORT_NOT_WIRED_NOTE}
      </p>

      {/*
        A REAL ORDERED LIST, because the order is the whole point: two carriers,
        in the order they are meant to be used, and a reader who hears the page
        hears "1, 2".
      */}
      <ol className="m-0 flex list-decimal flex-col gap-2 pl-5 text-meta leading-base text-muted">
        <li className="min-w-0">
          <p className="m-0 text-meta leading-base text-fg">Direct — straight to your daemon.</p>
          <p className="m-0 text-meta leading-base text-muted">
            Nothing to deploy and nobody else on the path. This is the path the app has today, and it needs the daemon
            to be reachable from here: same network, a VPN, a tailnet, or a public address.
          </p>
        </li>
        <li className="min-w-0">
          <p className="m-0 text-meta leading-base text-fg">
            Ferretry&rsquo;s hosted relay — the fallback, once anything dials it.
          </p>
          <FallbackReadout fallback={fallback} />
        </li>
      </ol>

      <Aside summary="What the hosted relay would see">
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
          {HOSTED_RELAY_DISCLOSURE.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Aside>
    </div>
  );
}

/**
 * The one live fact on this step, in the four states it can be in.
 *
 * `role="status"` because it is a readout that arrives after first paint: the
 * page renders "checking", the answer lands, and a reader who is not watching
 * this line is told rather than left with stale text.
 */
function FallbackReadout({ fallback }: { readonly fallback: HostedRelayFallback }) {
  if (fallback.kind === 'checking') {
    return (
      <p className="m-0 text-meta leading-base text-muted" role="status">
        Checking whether the hosted relay is available&hellip;
      </p>
    );
  }
  if (fallback.kind === 'available') {
    return (
      <p className="m-0 text-meta leading-base text-muted" role="status">
        Available now, at <code className="font-mono text-syn-string">{fallback.relayUrl}</code>. Used only if direct
        does not work.
      </p>
    );
  }
  if (fallback.kind === 'disabled') {
    return (
      <p className="m-0 text-meta leading-base text-warn" role="status">
        {HOSTED_RELAY_DISABLED_NOTE}
      </p>
    );
  }
  return (
    <p className="m-0 text-meta leading-base text-warn" role="status">
      Unavailable &mdash; {fallback.reason}. {HOSTED_RELAY_UNDETERMINED_NOTE}
    </p>
  );
}

/**
 * THE AGENT ROUTE'S OWN STEP: one prompt, shown in full, one tap to copy.
 *
 * The prompt is on the glass rather than behind a disclosure because a reader is
 * about to hand it to something that has a shell on their machine, and "copy
 * this text I will not show you" is not a thing to ask of anybody. It is also
 * generic by construction — it names no host, no user and no daemon — and seeing
 * that for themselves is the point.
 */
export function BriefStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <div className="flex min-w-0 flex-col rounded-control border border-code-border bg-code-bg">
        <div className="flex min-w-0 items-center gap-2 border-b border-code-border py-1 pl-2 pr-1">
          <span className="min-w-0 flex-1 truncate text-meta font-semibold text-fg">Setup prompt for an AI agent</span>
          <CopyButton text={AGENT_SETUP_PROMPT} label="Copy setup prompt" write={write} />
        </div>
        {/*
          Scrolls inside its own box: it is thirty lines, and a stage that grows
          to thirty lines pushes its own next action off a phone.
        */}
        <pre
          className="m-0 max-h-56 overflow-auto px-2 py-2 font-mono text-meta leading-base text-code-fg"
          data-onboarding-prompt=""
        >
          <code>{AGENT_SETUP_PROMPT}</code>
        </pre>
      </div>
      <p className="m-0 text-meta leading-base text-muted">
        It says nothing about you, this browser, or any daemon. When your agent shows you the QR or the link, continue.
      </p>
    </div>
  );
}

export function PairStage({ write, pairing }: { readonly write: ClipboardWriter; readonly pairing: ReactNode }) {
  return (
    <div className={STAGE}>
      <CommandBlock command={PAIR_COMMAND} copyLabel="Copy pair command" write={write} />
      {/*
        Kept on the glass rather than folded away: a code that has quietly
        expired is the one failure on this screen a reader cannot diagnose.
      */}
      <p className="m-0 text-meta leading-base text-muted">
        It prints a QR code and a link. One use, about two minutes.
      </p>
      <div className="min-w-0" data-onboarding-pairing="">
        {pairing}
      </div>
    </div>
  );
}

/**
 * The pair step WITHOUT the command, for the reader who already has a link.
 *
 * Somebody whose camera just opened this page has nothing to run: printing
 * `fy pair` at them describes a thing that has already happened, on a machine
 * they may not be standing at. The pairing surface itself is the same one, and
 * is not forked.
 */
export function ScanStage({ pairing }: { readonly pairing: ReactNode }) {
  return (
    <div className={STAGE}>
      <div className="min-w-0" data-onboarding-pairing="">
        {pairing}
      </div>
      <Aside summary="No link yet?">
        <p className="m-0 text-meta leading-base text-muted">
          Run <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> on the machine that runs the daemon. It
          prints a QR code and a link — one use, about two minutes.
        </p>
      </Aside>
    </div>
  );
}

export interface DoneStageProps {
  readonly fleetReady: boolean;
  readonly onOpenFleet: () => void;
  readonly onBackToPairing: () => void;
}

export function DoneStage({ fleetReady, onOpenFleet, onBackToPairing }: DoneStageProps) {
  return (
    <div className={STAGE}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta leading-base text-muted">
        <li>This browser remembers the pairing.</li>
        <li>Pair another machine later — each keeps its own data.</li>
      </ul>
      {/*
        DAMAGED STATE IS NOT EMPTY STATE. A stored "finished" with nothing paired
        in this browser is not a fleet to open; it is a step that has to be done
        again, and the button says so rather than opening onto nothing.
      */}
      {fleetReady ? null : (
        <p className="m-0 text-meta leading-base text-warn" role="status">
          Nothing is paired in this browser yet.
        </p>
      )}
      <button
        type="button"
        className="kt-btn min-h-[44px] w-full"
        data-variant="primary"
        onClick={fleetReady ? onOpenFleet : onBackToPairing}
        data-onboarding-open-fleet=""
      >
        {fleetReady ? 'Open my fleet' : 'Back to pairing'}
        {fleetReady ? <ExternalLink size={16} aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
