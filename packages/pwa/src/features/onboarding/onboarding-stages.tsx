/**
 * THE FOUR STAGES: heading, one command, one action.
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
 */

import { ExternalLink } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { CommandBlock } from './command-block.tsx';
import { type ClipboardWriter, CopyButton } from './copy-button.tsx';
import {
  AGENT_SETUP_PROMPT,
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

const CHANNEL =
  'h-8 rounded-control border px-2 text-meta focus-visible:outline-focus focus-visible:outline-offset-focus';

const CHANNEL_TONE = {
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

interface CopyRowProps {
  /** What the reader sees. */
  readonly label: string;
  /** What the control is called. Spelled out rather than derived from the label,
   * which would produce names like "Copy setup prompt for an ai agent". */
  readonly copyLabel: string;
  readonly text: string;
  readonly write: ClipboardWriter;
}

/** A labelled copy for text that is not a command and would be absurd to print. */
function CopyRow({ label, copyLabel, text, write }: CopyRowProps) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-surface py-1 pl-2 pr-1">
      <span className="min-w-0 flex-1 truncate text-meta text-fg">{label}</span>
      <CopyButton text={text} label={copyLabel} write={write} />
    </div>
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
  return (
    <div className={STAGE}>
      {/*
        A row of buttons that swaps what is shown below it. `role="toolbar"`
        rather than a tablist: there is no tab panel per option, and rather than
        a bare labelled div, which is not a nameable element.
      */}
      <div role="toolbar" aria-label="Install method" className="flex flex-wrap gap-1">
        {INSTALL_CHANNELS.map(option => (
          <button
            key={option.id}
            type="button"
            className={`${CHANNEL} ${option.id === selected ? CHANNEL_TONE.on : CHANNEL_TONE.off}`}
            aria-pressed={option.id === selected}
            onClick={() => setSelected(option.id)}
            data-onboarding-channel={option.id}
          >
            {option.label}
          </button>
        ))}
      </div>

      <CommandBlock command={installChannel(selected).command} copyLabel="Copy install command" write={write} />

      <Aside summary="Check it, or let an agent do it">
        <CommandBlock command={VERIFY_COMMAND} copyLabel="Copy check" write={write} />
        <CopyRow
          label="Setup prompt for an AI agent"
          copyLabel="Copy setup prompt"
          text={AGENT_SETUP_PROMPT}
          write={write}
        />
        <p className="m-0 text-meta leading-base text-muted">
          Generic setup text — it says nothing about you, this browser, or any daemon.
        </p>
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
