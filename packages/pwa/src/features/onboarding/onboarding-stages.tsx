/**
 * THE STAGES: one page, one thing to do.
 *
 * A page the reader can finish by doing one thing is one page. The agent answer,
 * the pairing entry and "another computer" are each a SINGLE page now — what to do
 * and the pairing surface sit together — and installing by hand on this computer is
 * three: install and start, open, and the optional phone. Everything that answers
 * "why" or "what if" sits behind a disclosure, closed by default.
 *
 * THE PRIMARY CONTROL IS THE STEP'S ACTION. On the agent page and the "another
 * computer" page that is a labelled copy; on the pairing page it is the scan. Any
 * pairing surface sitting UNDER such a primary is drawn quiet (`quiet`), because
 * "scan this if the other thing shows a QR" is a fallback, not the next move, and
 * two filled buttons is a page with no next move.
 *
 * NOTHING HONEST WAS DROPPED. The verification command, the healthy daemon's
 * output and the two-minute expiry are all still on the page — they are simply no
 * longer competing with the instruction.
 *
 * EVERY STAGE HERE IS REUSED BY EVERY JOURNEY THAT NEEDS IT, including "add
 * another daemon" — a second copy of the daemon instructions is a second copy to
 * keep true, and one of the two would be wrong within a release.
 */

import { Share2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CommandBlock } from './command-block.tsx';
import { type ClipboardWriter, CopyAction } from './copy-button.tsx';
import type { HostedRelayFallback } from './hosted-relay.ts';
import { OnboardingConnectionNote } from './onboarding-connection-note.tsx';
import {
  agentSetupPrompt,
  DAEMON_INSTALL_COMMAND,
  DAEMON_START_COMMAND,
  INSTALL_CHANNELS,
  type InstallChannelId,
  installChannel,
  PAIR_COMMAND,
  PAIR_OPEN_COMMAND,
  type SetupTargetId,
} from './onboarding-model.ts';
import type { SetupSharePort } from './setup-handoff-panel.tsx';

const STAGE = 'flex min-w-0 flex-col gap-2';

const CHOICE =
  'min-h-[36px] rounded-control border px-2 text-meta focus-visible:outline-focus focus-visible:outline-offset-focus';

const CHOICE_TONE = {
  on: 'border-accent bg-accent-soft font-semibold text-fg',
  off: 'border-border bg-surface-2 text-muted',
} as const;

const LINK =
  'inline-flex min-h-[44px] items-center self-start text-meta text-muted underline underline-offset-2 hover:text-fg focus-visible:outline-focus focus-visible:outline-offset-focus';

const COPY = 'm-0 text-meta leading-base text-muted';

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

/** The pairing surface, wherever a stage embeds it. */
function Pairing({ children }: { readonly children: ReactNode }) {
  return (
    <div className="min-w-0" data-onboarding-pairing="">
      {children}
    </div>
  );
}

/** What to do when a pairing code did not take, said once and not when the screen already said its own remedy. */
function ExpiryNote({ stated, children }: { readonly stated: boolean; readonly children: ReactNode }) {
  return stated ? null : <p className="m-0 text-2xs leading-base text-faint">{children}</p>;
}

export interface InstallStageProps {
  readonly write: ClipboardWriter;
  /** The detected install route. A guess; every other route stays one tap away. */
  readonly channel: InstallChannelId;
}

/**
 * INSTALL AND START, as ONE block to copy.
 *
 * The detected platform's commands are `INSTALL_CHANNELS` verbatim — they are
 * pinned against `INSTALLATION.md`, so none of them is ever reworded here — with
 * `fy daemon start` appended, because two blocks read as two decisions and one
 * paste into one terminal is the whole job. The other platforms are behind a link
 * rather than a row of buttons.
 */
export function InstallStage({ write, channel }: InstallStageProps) {
  const [selected, setSelected] = useState<InstallChannelId>(channel);
  const [choosing, setChoosing] = useState(false);
  const chosen = installChannel(selected);
  const guessed = installChannel(channel);
  return (
    <div className={STAGE}>
      <p className={COPY}>
        {selected === channel ? 'Detected: ' : 'For: '}
        {chosen.label}
      </p>

      <CommandBlock
        command={`${chosen.command}\n${DAEMON_START_COMMAND}`}
        copyLabel="Copy install and start commands"
        write={write}
      />

      {/*
        Said only for the fallback, and only when it is showing: a reader who
        picked `brew` does not need to be told what the script would have done,
        and a reader who landed on the script does need to know that a first-class
        route may exist for their machine.
      */}
      {chosen.fallback === undefined ? null : (
        <p className="m-0 text-meta leading-base text-muted" data-onboarding-fallback-note="">
          The generic fallback. It works on every supported target — but if your machine is named in the list, that
          route is packaged and, on macOS, clears the Gatekeeper quarantine for you.
        </p>
      )}

      {choosing ? (
        /*
          A row of buttons that swaps what is shown above it. `role="toolbar"`
          rather than a tablist: there is no tab panel per option. A GRID, not a
          wrapping row — labels of different widths wrap into a ragged last row,
          which reads as a mistake rather than a choice.
        */
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
      ) : (
        <button type="button" className={LINK} onClick={() => setChoosing(true)} data-onboarding-other-platforms="">
          {guessed.fallback === undefined ? `Not ${guessed.label}?` : 'Other platforms'}
        </button>
      )}

      <p className={COPY}>Needs Claude Code or Codex — Ferretry offers to install them once you are in.</p>

      <Aside summary="Keep it running after a reboot">
        <CommandBlock command={DAEMON_INSTALL_COMMAND} copyLabel="Copy service command" write={write} />
        <p className={COPY}>Installs the user service and starts the daemon under it.</p>
      </Aside>
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
  /** The real pairing surface, for the case where the agent shows a QR instead of opening Ferretry. */
  readonly pairing: ReactNode;
  /** The pairing failure on screen already says its remedy, so the code-expiry advice is not added. */
  readonly stated?: boolean;
  /** The pairing screen is past its resting scan (confirming, retrying or failed) and draws its own primary. */
  readonly engaged?: boolean;
}

/**
 * THE AGENT PAGE: copy one prompt, then wait for Ferretry to open.
 *
 * The reader said an agent does it, and everything that answer promises is carried
 * by the prompt. It is still SHOWN IN FULL one tap away — a person is about to hand
 * it to something with a shell on their machine, and "copy this text I will not
 * show you" is not a thing to ask of anybody. It is generic by construction: it
 * names no host, no user, no daemon and no fleet.
 *
 * THE ONLY WAY BACK IN IS THE DAEMON ANSWERING. On the daemon's own machine the
 * agent runs `fy pair --open`, which opens Ferretry already paired, and the page
 * finishes by itself. When the agent shows a QR or a link instead, the reader
 * scans or pastes it into the same pairing surface every other page uses.
 *
 * A COPY BUTTON IS NOT A HAND-OFF WHEN THE AGENT IS ON ANOTHER MACHINE: a phone's
 * clipboard does not reach a laptop. There is no QR to fix it — nothing on a desk
 * points a camera at a phone — so the answer is words and the OS share sheet, and
 * the plain page address beside it, because the prompt is public and identical on
 * every device.
 */
export function BriefStage({
  write,
  target,
  plainUrl,
  share,
  pairing,
  stated = false,
  engaged = false,
}: BriefStageProps) {
  const prompt = agentSetupPrompt(target);
  const here = target === 'this';
  return (
    <div className={STAGE}>
      <p className={COPY}>
        1. Copy this prompt into Claude Code or Codex{' '}
        <strong className="font-semibold text-fg">on {here ? 'this computer' : 'that computer'}</strong>.
      </p>
      <CopyAction text={prompt} label="Copy prompt" write={write} demoted={engaged} />

      <Aside summary="Show prompt">
        {/* Scrolls inside its own box: it is thirty lines, and a stage that grows to thirty lines pushes its own next action off a phone. */}
        <pre
          className="m-0 max-h-56 overflow-auto rounded-control border border-code-border bg-code-bg px-2 py-2 font-mono text-meta leading-base text-code-fg"
          data-onboarding-prompt=""
        >
          <code>{prompt}</code>
        </pre>
        <p className={COPY}>
          It says nothing about you, this browser, or any daemon. It ends by asking your agent to{' '}
          {here ? (
            <>
              run <code className="font-mono text-syn-string">{PAIR_OPEN_COMMAND}</code>, which opens Ferretry here
              already paired
            </>
          ) : (
            <>
              run <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> and show you the code
            </>
          )}
          .
        </p>
      </Aside>

      {here ? null : (
        <div className="flex min-w-0 flex-col gap-2" data-onboarding-prompt-handoff="">
          <p className={COPY}>
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
      )}

      <p className={COPY} data-onboarding-after="">
        {here
          ? '2. When it finishes, Ferretry opens here by itself. If it shows a QR:'
          : '2. When it finishes, it shows a QR or a link. Scan it or paste it here:'}
      </p>
      <Pairing>{pairing}</Pairing>
      <ExpiryNote stated={stated}>
        The code is single-use and expires after about two minutes. If it has expired, ask your agent to run{' '}
        <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> again and show you the fresh one.
      </ExpiryNote>
    </div>
  );
}

export interface LocalStageProps {
  readonly write: ClipboardWriter;
  /** The real pairing surface, for a terminal that cannot open a browser. */
  readonly pairing: ReactNode;
  /** What the runtime advertisement said about the default relay. */
  readonly fallback: HostedRelayFallback;
  readonly stated?: boolean;
}

/**
 * THE SAME-MACHINE COLLAPSE: the page where there is nothing to scan.
 *
 * The reader said this machine will run the daemon. The browser reading this
 * sentence is therefore ALREADY on the daemon's machine — it is localhost — and
 * asking them to photograph their own screen with their own phone is the most
 * absurd thing the old flow did.
 *
 * `fy pair --open` is what makes this real rather than a claim: the daemon mints
 * the same single-use link it would have drawn as a QR, and the CLI hands it to
 * the host's own browser. The page finishes by itself when the daemon answers.
 *
 * THE FALLBACK IS NOT HIDDEN BECAUSE IT IS COMMON. A headless box, a remote shell,
 * an SSH session, a browser the OS will not launch — plenty of terminals cannot
 * open a window. So the plain `fy pair` output and the same pairing surface are
 * one tap away, not gone.
 *
 * HOW OTHER DEVICES REACH THIS COMPUTER is said here, in a disclosure, because
 * this is the step where the daemon they will reach is up — there is nothing to
 * decide, only a fact to be able to read.
 */
export function LocalStage({ write, pairing, fallback, stated = false }: LocalStageProps) {
  return (
    <div className={STAGE}>
      <CommandBlock command={PAIR_OPEN_COMMAND} copyLabel="Copy open command" write={write} />
      <p className={COPY}>Ferretry opens in this browser, already paired. Nothing to scan.</p>
      <Aside summary="It did not open a browser">
        <p className={COPY}>
          A headless host, a remote shell or a locked-down desktop cannot launch one. Run{' '}
          <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> instead and paste the link it prints below.
        </p>
        <Pairing>{pairing}</Pairing>
        <ExpiryNote stated={stated}>The link is single-use and expires after about two minutes.</ExpiryNote>
      </Aside>
      <Aside summary="About connections">
        <OnboardingConnectionNote fallback={fallback} />
      </Aside>
    </div>
  );
}

export interface ElsewhereStageProps {
  /** The hand-off, already built by the page — this stage does not know the origin. */
  readonly handoff: ReactNode;
  /** The real pairing surface, for when that computer shows a QR. */
  readonly pairing: ReactNode;
  /** Switch to adding this browser as a client of a daemon that already exists. */
  readonly onAddAsClient: () => void;
  readonly stated?: boolean;
}

/**
 * THE ENTIRE "ANOTHER COMPUTER, MYSELF" BRANCH — one page, and it teaches nothing.
 *
 * THE RECURSION IS THE SIMPLIFICATION. This page does not explain how to install
 * Ferretry on a machine the reader is not sitting at, because that explanation
 * would be a second copy of the install instructions written about somebody else's
 * keyboard. It hands the setup link over, and that computer walks the same
 * subflow answering "this one", where every instruction is about the machine
 * under the reader's hands.
 *
 * THEN IT WAITS FOR THAT COMPUTER'S QR, here, with the same pairing surface every
 * other page uses — so a reader never has to come back to a different page to
 * finish.
 *
 * NO DEAD END AND NO APOLOGY. The other thing the reader may have meant — a daemon
 * that already exists, which this browser only wants to watch — is one tap away.
 */
export function ElsewhereStage({ handoff, pairing, onAddAsClient, stated = false }: ElsewhereStageProps) {
  return (
    <div className={STAGE}>
      <p className={COPY}>Agents need a terminal, so open this link on the computer that will run them.</p>
      {handoff}
      <p className={COPY}>When that computer shows a QR, scan it here:</p>
      <Pairing>{pairing}</Pairing>
      <ExpiryNote stated={stated}>
        The code is single-use and expires after about two minutes. If it has expired, run{' '}
        <code className="font-mono text-syn-string">{PAIR_COMMAND}</code> there again.
      </ExpiryNote>
      <Aside summary="A daemon already exists?">
        <p className={COPY}>Then nothing needs installing. Add this device as a client of it instead.</p>
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
 * OPTIONAL, and says so in its title. The QR carries only the public setup link —
 * a route and a step, no daemon address and no code — so it is safe to photograph;
 * the pairing code travels the OTHER way, from `fy pair`, and never through here.
 */
export function HandoffStage({ handoff }: { readonly handoff: ReactNode }) {
  return (
    <div className={STAGE}>
      {handoff}
      <p className={COPY}>Not now? Skip — add a phone any time from the machine menu.</p>
    </div>
  );
}

export interface PairStageProps {
  /** The real pairing surface. */
  readonly pairing: ReactNode;
  readonly stated?: boolean;
}

/**
 * THE PAIRING ENTRY: the reader is holding (or about to be holding) a QR or a link.
 *
 * Two sentences and the pairing surface, which here IS the page's action — so it
 * is drawn loud, unlike the pairing under a copy on the other pages. Somebody whose
 * camera just opened this page has nothing to run, but somebody who walked here
 * from the entry may not have run `fy pair` yet, so the command is named once.
 */
export function PairStage({ pairing, stated = false }: PairStageProps) {
  return (
    <div className={STAGE}>
      <p className={COPY}>
        1. On the computer running Ferretry, run <code className="font-mono text-syn-string">{PAIR_COMMAND}</code>.
      </p>
      <p className={COPY}>2. Scan the QR it shows.{stated ? '' : ' The code works once, for about two minutes.'}</p>
      <Pairing>{pairing}</Pairing>
    </div>
  );
}
