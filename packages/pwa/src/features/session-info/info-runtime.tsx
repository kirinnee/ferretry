/**
 * Info › Runtime: what this ferret runs as — the CLI, the login, the model it asked for and the one it
 * is actually answering with, and what it can reach.
 *
 * The model row reads the session's own truth: `config.model` (else the launch hint) as REQUESTED and
 * `state.observedModel` as OBSERVED, and flags a mismatch rather than letting a declined switch look
 * like a successful one. The pickers that CHANGE the model and effort are another surface's
 * (`runtime-controls`); `controls` is the slot a host hands them in through, and Info draws nothing
 * in their place when it is absent.
 */

import type { SessionView } from '@ferretry/protocol';
import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  agendaLabel,
  agendaOn,
  effortLabel,
  harnessLabel,
  hypermediaLabel,
  hypermediaOn,
  INFO_HINT,
  launchInstructionFacts,
  learningLabel,
  loginScope,
  modelFacts,
  packLabel,
  packOn,
  remoteControlLabel,
} from './info-model.ts';
import { InfoChip, InfoRow, InfoSection } from './info-parts.tsx';
import { type InfoRelaunchRead, InfoRelaunchRow } from './info-relaunch.tsx';

/** A list read once for a row: unread, read, or failed with a reason. */
export type InfoListRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly items: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string };

export interface InfoRuntimeProps {
  readonly view: SessionView;
  /** Other MCP servers this ferret sees (not Ferretry's own). */
  readonly mcp: InfoListRead;
  /** Instruction files at the folder's root. */
  readonly instructions: InfoListRead;
  /** How many skills it can run, or null when unread. */
  readonly skills: number | null;
  /** The model and effort pickers, when a host has them. */
  readonly controls?: ReactNode;
  /**
   * Whether this ferret is instructed to file lessons (the passive-learning flag the Actions toggle and
   * the list chip read). Null: not read yet, or the daemon cannot say. Absent: the host has no such read,
   * and the row is not drawn.
   */
  readonly learning?: boolean | null;
  /** Whether a Restart would relaunch it on different settings. Absent: no Settings row. */
  readonly relaunch?: InfoRelaunchRead;
  /** The Restart the Settings row offers when it is behind. */
  readonly onRestart?: () => Promise<void>;
}

const listText = (read: InfoListRead, empty: string): ReactNode =>
  read.kind === 'loading' ? (
    <span className="fy-info-muted">Reading…</span>
  ) : read.kind === 'failed' ? (
    <span className="fy-info-muted">Couldn’t read: {read.reason}</span>
  ) : read.items.length === 0 ? (
    <span className="fy-info-muted">{empty}</span>
  ) : (
    read.items.join(', ')
  );

export function InfoRuntime({
  view,
  mcp,
  instructions,
  skills,
  controls,
  learning,
  relaunch,
  onRestart,
}: InfoRuntimeProps) {
  const model = modelFacts(view);
  const launched = launchInstructionFacts(view);
  return (
    <InfoSection>
      <InfoRow label="CLI">{harnessLabel(view)}</InfoRow>
      <InfoRow hint={INFO_HINT.login} label="Login">
        <span className="font-mono">{view.config.agent}</span>
        <InfoChip>{loginScope(view)}</InfoChip>
      </InfoRow>
      <InfoRow hint={model.mismatch ? INFO_HINT.modelMismatch : INFO_HINT.model} label="Model">
        <span className="fy-info-line">
          <span className="font-mono" data-info-model-requested="">
            {model.requested ?? '—'}
          </span>
          <span className="fy-info-muted">requested</span>
        </span>
        <span className="fy-info-line">
          <span className="font-mono" data-info-model-observed="">
            {model.observed ?? 'not reported yet'}
          </span>
          <span className="fy-info-muted">observed</span>
        </span>
        {model.mismatch ? (
          <InfoChip tone="warn">
            <TriangleAlert aria-hidden="true" size={11} />
            Mismatch
          </InfoChip>
        ) : null}
      </InfoRow>
      <InfoRow hint={INFO_HINT.effort} label="Effort">
        {effortLabel(view)}
      </InfoRow>
      {controls === undefined ? null : <InfoRow label="Change">{controls}</InfoRow>}
      {relaunch === undefined ? null : (
        <InfoRelaunchRow read={relaunch} {...(onRestart === undefined ? {} : { onRestart })} />
      )}
      <InfoRow hint={INFO_HINT.mode} label="Mode">
        {view.config.mode}
      </InfoRow>
      <InfoRow hint={INFO_HINT.remoteControl} label="Remote control">
        <span data-info-remote-control={view.config.remoteControl ? 'on' : 'off'}>{remoteControlLabel(view)}</span>
      </InfoRow>
      <InfoRow hint={INFO_HINT.ferretryTools} label="Ferretry tools">
        <InfoChip tone="ok">On</InfoChip>
      </InfoRow>
      <InfoRow hint={INFO_HINT.instructions} label="Instructions">
        {launched === undefined ? (
          <span className="fy-info-muted" data-info-launch-unrecorded="">
            Recorded from the next launch
          </span>
        ) : (
          <>
            <span className="fy-info-line" data-info-launch-sections="">
              {launched.sections.map(section => (
                <InfoChip key={section.id} tone="accent">
                  <span data-info-launch-section={section.id}>{section.label}</span>
                </InfoChip>
              ))}
            </span>
            <span className="fy-info-line" data-info-launch-mode="">
              <span className="fy-info-muted">Mode</span>
              {launched.mode}
            </span>
            <span className="fy-info-line" data-info-launch-questions="">
              <span className="fy-info-muted">Can ask questions</span>
              {launched.questions}
            </span>
          </>
        )}
      </InfoRow>
      <InfoRow label="Other MCP">{listText(mcp, 'None')}</InfoRow>
      <InfoRow hint={INFO_HINT.instructionFiles} label="Instruction files">
        {listText(instructions, 'None at the folder’s root')}
      </InfoRow>
      <InfoRow label="Skills">
        {skills === null ? <span className="fy-info-muted">Reading…</span> : `${skills} available`}
      </InfoRow>
      {learning === undefined ? null : (
        <InfoRow hint={INFO_HINT.learning} label="Learning">
          {learning === null ? (
            <span className="fy-info-muted">Not reported yet</span>
          ) : (
            <span data-info-learning={learning ? 'on' : 'off'}>{learningLabel(learning)}</span>
          )}
        </InfoRow>
      )}
      <InfoRow hint={INFO_HINT.hypermedia} label="Hypermedia">
        <span data-info-hypermedia={hypermediaOn(view) ? 'on' : 'off'}>{hypermediaLabel(hypermediaOn(view))}</span>
      </InfoRow>
      <InfoRow hint={INFO_HINT.pack} label="Pack mode">
        <span data-info-pack={packOn(view) ? 'on' : 'off'}>{packLabel(packOn(view))}</span>
        <span className="fy-info-muted">takes effect at the next launch</span>
      </InfoRow>
      <InfoRow hint={INFO_HINT.agenda} label="Agenda mode">
        <span data-info-agenda={agendaOn(view) ? 'on' : 'off'}>{agendaLabel(agendaOn(view))}</span>
        <span className="fy-info-muted">takes effect at the next launch</span>
      </InfoRow>
    </InfoSection>
  );
}
