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
 * THERE IS NO "LET AN AGENT DO IT" PATH (owner, C59 O7): installing needs permissions an agent usually does not have,
 * so the page opens on the commands the reader runs themselves.
 *
 * THE CLAUDE CODE / CODEX INSTALL IS NOT HERE EITHER. These stages stand the daemon up and pair; the setup flow that
 * follows pairing owns installing and signing in to each agent (the Claude and Codex steps), so there is no "install an
 * agent" stage and no "you are set up" page: pairing is the last thing this half does, and the page hands over then.
 *
 * EVERY STAGE HERE IS REUSED BY EVERY JOURNEY THAT NEEDS IT, including "add
 * another daemon" — a second copy of the daemon instructions is a second copy to
 * keep true, and one of the two would be wrong within a release.
 */

import { type ReactNode, useState } from 'react';

import { CommandBlock } from './command-block.tsx';
import type { ClipboardWriter } from '@ferretry/app/ui';
import {
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  VERIFY_COMMAND,
} from './onboarding-model.ts';

const STAGE = 'flex min-w-0 flex-col gap-2';

const CHOICE =
  'min-h-[44px] rounded-control border px-2 text-meta focus-visible:outline-focus focus-visible:outline-offset-focus';

const CHOICE_TONE = {
  on: 'border-accent bg-accent-soft font-semibold text-fg',
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

export interface InstallStageProps {
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  /**
   * Change the other answer: these commands are for a machine the reader is not at.
   *
   * Absent when the reader chose this machine outright, because then there is a
   * question one Back away and nothing to escape from.
   */
  readonly onOtherMachine?: (() => void) | undefined;
}

export function InstallStage({ write, channel, onOtherMachine }: InstallStageProps) {
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

      {/*
        THE SECOND PLACE THE ASSUMPTION CAN BE ESCAPED, and the one that catches
        the reader who did not read the screen before this. These commands are
        addressed to the machine holding this page; somebody who meant a different
        one has to be able to say so from the screen that is wrong for them, not
        only from the screen that stated the assumption.
      */}
      {onOtherMachine === undefined ? null : (
        <Aside summary="Setting up a different machine?">
          <p className="m-0 text-meta leading-base text-muted">
            These commands install Ferretry on the machine reading this page. If the agents are meant to run somewhere
            else, the setup happens over there instead.
          </p>
          <button
            type="button"
            className="kt-btn min-h-[44px] self-start"
            data-variant="ghost"
            onClick={onOtherMachine}
            data-onboarding-other-machine=""
          >
            It is another computer
          </button>
        </Aside>
      )}
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

/**
 * THE SAME-MACHINE COLLAPSE: the step where there is nothing to scan.
 *
 * The reader said this machine will run the daemon. The browser reading this
 * sentence is therefore ALREADY on the daemon's machine — it is localhost — and
 * asking them to photograph their own screen with their own phone, so the phone
 * can hand a code back to the browser eighteen inches away, is the single most
 * absurd thing the old flow did. It happened because the old arc could not tell
 * the two machines apart, so it always assumed they were different.
 *
 * `fy pair --open` is what makes this real rather than a claim: the daemon mints
 * the same single-use link it would have drawn as a QR, and the CLI hands it to
 * the host's own browser. The reader presses Enter and lands here paired.
 *
 * THE FALLBACK IS NOT HIDDEN BECAUSE IT IS COMMON. A headless box, a remote
 * shell, an SSH session, a browser the OS will not launch — plenty of terminals
 * cannot open a window. So the plain `fy pair` output and the same pairing
 * surface every other route uses are one tap away, not gone.
 */
export function LocalStage({ write, pairing }: { readonly write: ClipboardWriter; readonly pairing: ReactNode }) {
  return (
    <div className={STAGE}>
      <CommandBlock command={PAIR_OPEN_COMMAND} copyLabel="Copy open command" write={write} />
      <p className="m-0 text-meta leading-base text-muted">
        Run it in the same terminal. It opens Ferretry in this browser, already paired — no QR, no code to type.
      </p>
      <Aside summary="It did not open a browser">
        <p className="m-0 text-meta leading-base text-muted">
          A headless host, a remote shell or a locked-down desktop cannot launch one. Run{' '}
          <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> instead and paste the link it prints below.
        </p>
        <div className="min-w-0" data-onboarding-pairing="">
          {pairing}
        </div>
      </Aside>
    </div>
  );
}

export interface ElsewhereStageProps {
  /** The hand-off, already built by the page — this stage does not know the origin. */
  readonly handoff: ReactNode;
  /** Switch to adding this browser as a client of a daemon that already exists. */
  readonly onAddAsClient: () => void;
}

/**
 * THE ENTIRE "ANOTHER COMPUTER, MYSELF" BRANCH — one screen, and it teaches nothing.
 *
 * THE RECURSION IS THE SIMPLIFICATION. This screen does not explain how to install
 * Ferretry on a machine the reader is not sitting at, because that explanation
 * would be a second copy of the install instructions written in the second person
 * about somebody else's keyboard — and a second copy is a copy that goes wrong.
 * It says to open this page over there, and that computer walks the same subflow
 * answering "this one", where every instruction is about the machine under the
 * reader's hands.
 *
 * IT IS THE SAME SCREEN ON A PHONE AND ON A COMPUTER, which is why it replaced
 * `need-computer`. That screen existed only on a phone and its subject was this
 * device's unsuitability; a reader at a laptop setting up a home server needs
 * exactly this screen and is not being refused anything.
 *
 * NO DEAD END AND NO APOLOGY. The hand-off carries the place, and the other thing
 * the reader may have meant — a daemon that already exists, which this browser
 * only wants to watch — is one tap away rather than "go and read the docs".
 */
export function ElsewhereStage({ handoff, onAddAsClient }: ElsewhereStageProps) {
  return (
    <div className={STAGE}>
      <p className="m-0 text-meta leading-base text-muted">
        Open this page on the computer that will run your agents. It walks you through the install there, on that
        machine — then come back here to pair this device.
      </p>
      {handoff}
      <Aside summary="A daemon already exists?">
        <p className="m-0 text-meta leading-base text-muted">
          Then nothing needs installing. Add this device as a client of it instead.
        </p>
        <button
          type="button"
          className="kt-btn min-h-[44px] self-start"
          data-variant="ghost"
          onClick={onAddAsClient}
          data-onboarding-add-client=""
        >
          Add this as a client
        </button>
      </Aside>
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
export function ScanStage({ pairing, stated = false }: { readonly pairing: ReactNode; readonly stated?: boolean }) {
  return (
    <div className={STAGE}>
      <div className="min-w-0" data-onboarding-pairing="">
        {pairing}
      </div>
      {stated ? null : (
        <p className="m-0 text-meta leading-base text-muted">
          This code is single-use and expires after about two minutes. If it has expired, go back to your computer, run{' '}
          <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> again, then return here with the fresh QR or
          link.
        </p>
      )}
    </div>
  );
}
