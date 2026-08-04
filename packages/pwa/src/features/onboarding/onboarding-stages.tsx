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
  AGENT_SETUP_PROMPT,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  PAIR_COMMAND,
  PAIR_PRINT_COMMAND,
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

/** The detailed self-host path mirrors the relay runbook one operation at a time. */
export function RelayFingerprintStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <CommandBlock command={PAIR_PRINT_COMMAND} copyLabel="Copy fingerprint command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        Copy the <code className="font-mono text-syn-string">fy_daemon_…</code> fingerprint it prints. You will allow it
        at your relay next; make a fresh pairing code later.
      </p>
    </div>
  );
}

export function RelaySourceStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <CommandBlock
        command="git clone https://github.com/kirinnee/ferretry"
        copyLabel="Copy clone command"
        write={write}
      />
      <p className="m-0 text-meta leading-base text-muted">
        Run the remaining relay commands from that checkout, using your own Cloudflare account.
      </p>
    </div>
  );
}

export function RelayAllowStage() {
  return (
    <div className={STAGE}>
      <p className="m-0 text-meta leading-base text-muted">
        In <code className="font-mono text-syn-string">packages/relay/wrangler.jsonc</code>, set{' '}
        <code className="font-mono text-syn-string">vars.RELAY_DAEMON_IDS</code> to the fingerprint you copied. An empty
        list serves nobody.
      </p>
      <Aside summary="Why this is required">
        <p className="m-0 text-meta leading-base text-muted">
          Your relay cannot read what it carries, so the fingerprint list is its access control. Read the relay protocol
          runbook before making the deployment public.
        </p>
      </Aside>
    </div>
  );
}

export function RelayDeployStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <CommandBlock command="task relay:deploy" copyLabel="Copy deploy command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        This deploys a Worker and Durable Object to your account. Continue when the deploy has finished.
      </p>
    </div>
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

export function PairStage({ write }: { readonly write: ClipboardWriter }) {
  return (
    <div className={STAGE}>
      <CommandBlock command={PAIR_COMMAND} copyLabel="Copy pair command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        Run this on the computer where the daemon is running. Keep the QR code or link it prints on that screen.
      </p>
    </div>
  );
}

/**
 * The phone/browser half of pairing, without the command.
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
      <p className="m-0 text-meta leading-base text-muted">
        This code is single-use and expires after about two minutes. If it has expired, go back to your computer, run{' '}
        <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> again, then return here with the fresh QR or
        link.
      </p>
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
