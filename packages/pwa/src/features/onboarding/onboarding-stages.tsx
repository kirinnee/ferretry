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
 * WHO INSTALLS IT IS A QUESTION, NOT A DISCLOSURE ON THIS STEP. For one release
 * the agent path was folded in here, on the argument that an agent is just a way
 * of PERFORMING the install. That was wrong: an agent doing the setup means no
 * platform picker, no commands here and no `fy pair` by hand. What survives on the
 * install step is a one-tap way to CHANGE EITHER ANSWER — the doer, and the machine
 * these commands are addressed to — but never a second copy of the prompt, because
 * two copies of the thing that answer exists to hand over is two things to keep
 * true.
 *
 * EVERY STAGE HERE IS REUSED BY EVERY JOURNEY THAT NEEDS IT, including "add
 * another daemon" — a second copy of the daemon instructions is a second copy to
 * keep true, and one of the two would be wrong within a release.
 */

import { ExternalLink, Share2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CommandBlock } from './command-block.tsx';
import { type ClipboardWriter, CopyButton } from './copy-button.tsx';
import type { CarrierDisclosure } from './hosted-relay.ts';
import {
  agentSetupPrompt,
  DAEMON_INSTALL_COMMAND,
  DAEMON_SERVING_OUTPUT,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  PAIR_PRINT_COMMAND,
  type SetupTargetId,
  VERIFY_COMMAND,
} from './onboarding-model.ts';
import type { SetupSharePort } from './setup-handoff-panel.tsx';

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

export interface InstallStageProps {
  readonly write: ClipboardWriter;
  readonly channel: InstallChannelId;
  /** Change answer: hand the whole thing to an agent instead of typing it. */
  readonly onAgentInstead: () => void;
  /**
   * Change the other answer: these commands are for a machine the reader is not at.
   *
   * Absent when the reader chose this machine outright, because then there is a
   * question one Back away and nothing to escape from.
   */
  readonly onOtherMachine?: (() => void) | undefined;
}

export function InstallStage({ write, channel, onAgentInstead, onOtherMachine }: InstallStageProps) {
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
        CHANGING ANSWER, not a second copy of the agent path. A reader who is
        looking at a command they did not want should not have to find the way
        back to the first question and re-answer it; and the prompt itself lives
        on the agent route's own step, where it is the whole screen rather than
        thirty lines folded under a caret.
      */}
      <Aside summary="Rather have an agent do it?">
        <p className="m-0 text-meta leading-base text-muted">
          If you already have Claude or Codex on that machine, it can install Ferretry, start the daemon and pair with
          this browser. You copy one prompt and nothing else.
        </p>
        <button
          type="button"
          className="kt-btn min-h-[44px] w-full"
          data-variant="ghost"
          onClick={onAgentInstead}
          data-onboarding-agent-instead=""
        >
          Let an agent do it
        </button>
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
            className="kt-btn min-h-[44px] w-full"
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

export interface BriefStageProps {
  readonly write: ClipboardWriter;
  /**
   * Which computer the agent is on, which changes both the prompt and how the
   * prompt has to travel. The clipboard does not cross a device boundary.
   */
  readonly target: SetupTargetId;
  /** The bare setup page, for a reader who would rather open it on that computer. */
  readonly plainUrl: string;
  /** The OS share sheet, when this browser has one. Absent is the ordinary case. */
  readonly share?: SetupSharePort | undefined;
}

/**
 * THE AGENT PROMPT: on this answer it IS the product, so it is the whole screen.
 *
 * The reader said an agent does it, and everything that answer promises is carried
 * by this text. So it is shown in full rather than behind a second tap: a person
 * is about to hand it to something with a shell on their machine, and "copy this
 * text I will not show you" is not a thing to ask of anybody. It is also generic
 * by construction — it names no host, no user, no daemon and no fleet — and seeing
 * that for themselves is the point on a page anyone can load.
 *
 * A COPY BUTTON IS NOT A HAND-OFF WHEN THE AGENT IS ON ANOTHER MACHINE, and that
 * was the honest gap in the previous release: a phone's clipboard does not reach a
 * laptop, so "copy this" ended in the reader retyping thirty lines or giving up.
 * There is no QR to fix it either — nothing on a desk points a camera at a phone —
 * so the answer is words and the OS share sheet: Messages, mail, a note to
 * yourself, whatever that phone already has. And the plain page address is offered
 * beside it, because the prompt is public and identical on every device: opening
 * this page over there puts the same text one copy away, with nothing sent at all.
 */
export function BriefStage({ write, target, plainUrl, share }: BriefStageProps) {
  const prompt = agentSetupPrompt(target);
  return (
    <div className={STAGE}>
      <p className="m-0 text-meta leading-base text-muted">
        Paste it into Claude, Codex or any agent with a terminal{' '}
        <strong className="font-semibold text-fg">on {target === 'this' ? 'this computer' : 'that computer'}</strong> —
        not into anything on this page.
      </p>
      <div className="flex min-w-0 flex-col rounded-control border border-code-border bg-code-bg">
        <div className="flex min-w-0 items-center gap-2 border-b border-code-border py-1 pl-2 pr-1">
          <span className="min-w-0 flex-1 truncate text-meta font-semibold text-fg">Setup prompt for an AI agent</span>
          <CopyButton text={prompt} label="Copy setup prompt" write={write} />
        </div>
        {/*
          Scrolls inside its own box: it is thirty lines, and a stage that grows
          to thirty lines pushes its own next action off a phone.
        */}
        <pre
          className="m-0 max-h-56 overflow-auto px-2 py-2 font-mono text-meta leading-base text-code-fg"
          data-onboarding-prompt=""
        >
          <code>{prompt}</code>
        </pre>
      </div>

      {target === 'other' ? (
        <div className="flex min-w-0 flex-col gap-2" data-onboarding-prompt-handoff="">
          <p className="m-0 text-meta leading-base text-muted">
            That agent is on another computer, and this clipboard does not reach it. Send the prompt over — a message to
            yourself, mail, or your team chat.
          </p>
          {share === undefined ? null : (
            <button
              type="button"
              className="kt-btn min-h-[44px] w-full"
              data-variant="ghost"
              onClick={() => {
                /*
                 * A DECLINED SHARE SHEET IS NOT AN ERROR. Dismissing it rejects
                 * with `AbortError`, and an unhandled rejection here would be a
                 * console failure caused by a reader changing their mind.
                 */
                void share({ title: 'Ferretry setup prompt', text: prompt }).catch(() => undefined);
              }}
              data-onboarding-share-prompt=""
            >
              <Share2 size={16} aria-hidden="true" />
              Share the prompt
            </button>
          )}
          <p className="m-0 text-2xs leading-base text-faint">
            Or open <span className="font-mono text-syn-string">{plainUrl}</span> on that computer — the same prompt is
            on this screen there, ready to copy.
          </p>
        </div>
      ) : null}

      <p className="m-0 text-meta leading-base text-muted">
        It says nothing about you, this browser, or any daemon. It ends by asking your agent to{' '}
        {target === 'this' ? (
          <>
            run <code className="font-mono text-syn-string">{PAIR_OPEN_COMMAND}</code>, which opens Ferretry here
            already paired
          </>
        ) : (
          <>
            run <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> and show you the code
          </>
        )}{' '}
        — come back here when it does.
      </p>
    </div>
  );
}

export interface AgentPairStageProps {
  readonly pairing: ReactNode;
  /**
   * Which computer the agent is on — which decides whether "you may already be
   * connected" is true or a lie.
   *
   * It used to be this device's KIND, on the reasoning that a computer reading
   * this page was probably the daemon's own machine. That was a guess standing in
   * for a fact, and it was wrong for every reader on a laptop setting up a server.
   * The first question settles it, so the fact is passed instead: `fy pair --open`
   * opens a browser on the daemon's machine, which is this one exactly when the
   * reader said the daemon runs here.
   */
  readonly target: SetupTargetId;
}

/**
 * THE END OF THE AGENT ROUTE: the code came from the agent, not from the reader.
 *
 * Nothing here is a command, because nobody here has a terminal open — the agent
 * had it, on the other machine, and it was told to print a code and show it. So
 * this stage is the same pairing surface every other route uses, with the one
 * thing that is different about arriving here said plainly: the reader did not
 * produce this code and cannot re-produce it, so if it has expired the fix is to
 * ask the agent again rather than to go and type something.
 *
 * ON THE DAEMON'S OWN MACHINE THE JOURNEY MAY ALREADY BE OVER, and saying so is
 * not optional: the prompt tells the agent to run `fy pair --open` there, and that
 * opens Ferretry already paired IN ANOTHER TAB. Somebody left staring at a pairing
 * field while a finished app sits one tab away concludes the setup failed. It is
 * said only when the daemon is on this machine, because otherwise that tab opened
 * somewhere the reader is not sitting.
 */
export function AgentPairStage({ pairing, target }: AgentPairStageProps) {
  return (
    <div className={STAGE}>
      <div className="min-w-0" data-onboarding-pairing="">
        {pairing}
      </div>
      {target === 'this' ? (
        <p className="m-0 text-meta leading-base text-muted" data-onboarding-agent-opened="">
          If your agent ran <code className="font-mono text-syn-string">{PAIR_OPEN_COMMAND}</code> on this machine, it
          has already opened Ferretry in another tab, paired. Nothing to do here — carry on there.
        </p>
      ) : null}
      <p className="m-0 text-meta leading-base text-muted">
        The code is single-use and expires after about two minutes. If it has expired, ask your agent to run{' '}
        <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> again and show you the fresh one.
      </p>
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
          className="kt-btn min-h-[44px] w-full"
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
 * THE OTHER DIRECTION: the computer is done, and the phone is offered the same view.
 *
 * This is what makes first-time setup more than the other two answers in
 * sequence. It is OPTIONAL and says so — the reader is already finished, `Next`
 * skips it, and nothing here is a step they owe anybody.
 */
export function HandoffStage({ handoff }: { readonly handoff: ReactNode }) {
  return (
    <div className={STAGE}>
      <p className="m-0 text-meta leading-base text-muted">
        Your daemon is running and this browser is connected. Your phone can watch the same fleet — it needs the pairing
        code your computer is about to print.
      </p>
      {handoff}
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
  readonly connectionStatus: string | null;
  /**
   * What the carrier the reader CHOSE would be able to see.
   *
   * Absent for a direct connection, which has no third party in it. Restated
   * here rather than left behind on the chooser because that choice was made
   * several screens — and possibly several days — before anything was connected,
   * and this is the screen where the connection becomes real.
   */
  readonly fallbackDisclosure?: CarrierDisclosure | null;
  readonly onOpenFleet: () => void;
  readonly onBackToPairing: () => void;
}

export function DoneStage({
  fleetReady,
  connectionStatus,
  fallbackDisclosure = null,
  onOpenFleet,
  onBackToPairing,
}: DoneStageProps) {
  return (
    <div className={STAGE}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-meta leading-base text-muted">
        <li>This browser remembers the pairing.</li>
        <li>Pair another machine later — each keeps its own data.</li>
      </ul>
      {connectionStatus === null ? null : (
        <p className="m-0 text-2xs leading-base text-faint" role="status">
          Connection in use: {connectionStatus}
        </p>
      )}
      {fallbackDisclosure === null || fallbackDisclosure.fallbackWouldSee.length === 0 ? null : (
        <Aside summary={`What ${fallbackDisclosure.fallbackName} would see`}>
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0 text-meta leading-base text-muted"
            data-onboarding-fallback-disclosure=""
          >
            {fallbackDisclosure.fallbackWouldSee.map(line => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="m-0 text-2xs leading-base text-faint">
            It is the fallback, not the carrier: it only ever carries the connection when the direct path cannot.
          </p>
        </Aside>
      )}
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
