/** Info › Overview: who this ferret is, where it works, where it came from. */

import { GitBranch, Pencil } from 'lucide-react';
import type { FerretSummary } from '../../../contract/index.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import type { ClipboardWriter } from '../../ui.ts';
import { InfoAbout, type InfoAboutProps } from './info-about.tsx';
import { endCauseWord, INFO_HINT, lineage, projectFact, relativeTime, STATE_WORD, worktreeFact } from './info-model.ts';
import { InfoChip, InfoRow, InfoSection } from './info-parts.tsx';
import type { ManagedWorktree } from './info-wire.ts';

export interface InfoOverviewProps {
  readonly ferret: FerretSummary;
  readonly name: string;
  /** The machine's managed worktrees; null until read (or when they cannot be). */
  readonly worktrees: readonly ManagedWorktree[] | null;
  /** Every ferret on the machine, for lineage; absent until read. */
  readonly ferrets?: readonly FerretSummary[];
  readonly write: ClipboardWriter;
  readonly now: number;
  /** Opens Actions › Rename. Absent when this connection may not rename. */
  readonly onRename?: () => void;
  /** Goes to another ferret; the host decides where. */
  readonly onOpenFerret?: (ferretId: string) => void;
  /** The "About this ferret" block's Restart. */
  readonly about?: Pick<InfoAboutProps, 'onRestart' | 'overlayKey'>;
}

const ferretName = (ferret: FerretSummary): string => displayCallsign(ferret.name) || ferret.title || ferret.id;

export function InfoOverview({
  ferret,
  name,
  worktrees,
  ferrets,
  write,
  now,
  onRename,
  onOpenFerret,
  about,
}: InfoOverviewProps) {
  const tree = worktreeFact(ferret, worktrees);
  const family = lineage(ferret, ferrets);
  const project = projectFact(ferret);
  const link = (target: FerretSummary) =>
    onOpenFerret === undefined ? (
      <span key={target.id}>{ferretName(target)}</span>
    ) : (
      <button
        className="fy-info-link"
        data-info-ferret-link={target.id}
        key={target.id}
        onClick={() => onOpenFerret(target.id)}
        type="button"
      >
        {ferretName(target)}
      </button>
    );

  return (
    <>
      <InfoAbout
        ferret={ferret}
        subFerrets={family.children}
        {...(ferret.card === undefined ? {} : { card: ferret.card })}
        {...(onOpenFerret === undefined ? {} : { onOpenFerret })}
        {...about}
      />
      <InfoSection>
        <InfoRow label="Name">
          <strong>{name}</strong>
          {onRename === undefined ? null : (
            <button className="fy-info-inline-action" data-info-rename="" onClick={onRename} type="button">
              <Pencil aria-hidden="true" size={12} />
              Rename
            </button>
          )}
        </InfoRow>
        {ferret.title === undefined ? null : <InfoRow label="Task">{ferret.title}</InfoRow>}
        {ferret.label === undefined ? null : <InfoRow label="Label">{ferret.label}</InfoRow>}
        <InfoRow hint={INFO_HINT.state} label="State">
          <span data-info-state={ferret.state}>{STATE_WORD[ferret.state]}</span>
          {ferret.waiting === undefined ? null : (
            <InfoChip tone="warn">
              waiting{ferret.waiting.condition === undefined ? '' : `: ${ferret.waiting.condition}`}
            </InfoChip>
          )}
          {ferret.finishedAt === undefined ? null : <InfoChip tone="ok">said it is done</InfoChip>}
        </InfoRow>
        {ferret.cause === undefined ? null : (
          <InfoRow hint={INFO_HINT.cause} label="Ended">
            <span data-info-cause={ferret.cause.kind}>{endCauseWord(ferret.cause)}</span>
          </InfoRow>
        )}
        <InfoRow label="Project">
          {project === null ? (
            <span className="fy-info-muted">Not in a project</span>
          ) : (
            <span className="font-mono">{project}</span>
          )}
        </InfoRow>
        <InfoRow copy={ferret.folder} hint={INFO_HINT.folder} label="Folder" mono write={write}>
          {ferret.folder}
        </InfoRow>
        {tree.kind === 'worktree' ? (
          <InfoRow copy={tree.path} hint={INFO_HINT.worktree} label="Worktree" mono write={write}>
            {tree.path}
            <InfoChip tone="accent">
              <GitBranch aria-hidden="true" size={11} />
              {tree.branch}
            </InfoChip>
            {tree.dirty === true ? <InfoChip tone="warn">uncommitted changes</InfoChip> : null}
            {tree.dirty === false ? <InfoChip>clean</InfoChip> : null}
          </InfoRow>
        ) : (
          <InfoRow hint={INFO_HINT.worktree} label="Worktree">
            {tree.kind === 'main' ? 'Main checkout' : <span className="fy-info-muted">Unknown</span>}
          </InfoRow>
        )}
        <InfoRow hint={INFO_HINT.parent} label="Started by">
          {family.parent === null ? (
            <span className="fy-info-muted">Started by you</span>
          ) : typeof family.parent === 'string' ? (
            <span className="font-mono">{family.parent}</span>
          ) : (
            link(family.parent)
          )}
        </InfoRow>
        {ferret.pack === undefined ? null : (
          <InfoRow hint={INFO_HINT.pack} label="Pack">
            <span className="font-mono">{ferret.pack}</span>
          </InfoRow>
        )}
        <InfoRow copy={ferret.id} hint={INFO_HINT.ferretId} label="Ferret id" mono write={write}>
          {ferret.id}
        </InfoRow>
        <InfoRow label="Started">{relativeTime(ferret.createdAt, now)}</InfoRow>
        <InfoRow label="In this state since">{relativeTime(ferret.stateAt, now)}</InfoRow>
      </InfoSection>
    </>
  );
}
