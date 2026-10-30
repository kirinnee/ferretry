/** Info › Overview: who this ferret is, where it works, where it came from. */

import type { ManagedWorktreeView, SessionView } from '@ferretry/protocol';
import { GitBranch, Pencil } from 'lucide-react';
import { SubFerretsPack, activeSubFerrets } from '../../components/sub-ferrets.tsx';
import { type ChatChip, chatCardLabel } from '../../lib/board-chat.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import type { ClipboardWriter } from '../onboarding/copy-button.tsx';
import { INFO_HINT, lineage, worktreeFact } from './info-model.ts';
import { InfoChip, InfoRow, InfoSection } from './info-parts.tsx';

export interface InfoOverviewProps {
  readonly view: SessionView;
  readonly name: string;
  readonly project: string | null;
  /** The machine's managed worktrees; null until read (or when they cannot be). */
  readonly worktrees: readonly ManagedWorktreeView[] | null;
  readonly sessions?: readonly SessionView[];
  readonly write: ClipboardWriter;
  readonly now: number;
  /** Opens Actions › Rename. Absent when this connection may not rename. */
  readonly onRename?: () => void;
  /** Goes to another ferret: `/d/<daemon>/s/<id>` style, decided by the host. */
  readonly onOpenSession?: (sessionId: string) => void;
  /** The ferret's focus card and how to open it. Absent: the host has no board, so there is no Card row. */
  readonly card?: { readonly chip: ChatChip; readonly onOpen: () => void };
}

const sessionName = (view: SessionView): string => displayCallsign(view.config.teammate) || view.config.name;

export function InfoOverview({
  view,
  name,
  project,
  worktrees,
  sessions,
  write,
  now,
  onRename,
  onOpenSession,
  card,
}: InfoOverviewProps) {
  const tree = worktreeFact(view, worktrees);
  const family = lineage(view, sessions);
  const link = (target: SessionView) =>
    onOpenSession === undefined ? (
      <span key={target.config.id}>{sessionName(target)}</span>
    ) : (
      <button
        className="fy-info-link"
        data-info-session-link={target.config.id}
        key={target.config.id}
        onClick={() => onOpenSession(target.config.id)}
        type="button"
      >
        {sessionName(target)}
      </button>
    );

  return (
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
      <InfoRow label="Task">{view.config.name}</InfoRow>
      {view.config.label === undefined ? null : <InfoRow label="Label">{view.config.label}</InfoRow>}
      <InfoRow label="Project">{project ?? <span className="fy-info-muted">Not in a project</span>}</InfoRow>
      <InfoRow copy={view.config.cwd} hint={INFO_HINT.folder} label="Folder" mono write={write}>
        {view.config.cwd}
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
      <InfoRow label={`Sub-ferrets (${activeSubFerrets(family.children).length})`}>
        {family.children.length === 0 ? (
          <span className="fy-info-muted">None</span>
        ) : (
          // Each with how it is doing now and the model it runs on, so a parent reads its pack here.
          // Only the active ones show; the finished are one tap away.
          <SubFerretsPack onOpenSession={onOpenSession} sessions={family.children} />
        )}
      </InfoRow>
      <InfoRow copy={view.config.id} hint={INFO_HINT.sessionId} label="Session id" mono write={write}>
        {view.config.id}
      </InfoRow>
      <InfoRow label="Started">{relativeTime(view.state.startedAt ?? view.config.createdAt, now)}</InfoRow>
      <InfoRow label="Last activity">{relativeTime(view.state.lastActivityAt, now)}</InfoRow>
      {card === undefined ? null : (
        <InfoRow label="Card">
          {card.chip.kind === 'none' ? (
            <span className="fy-info-warn" data-info-card="none">
              No card
            </span>
          ) : (
            <button
              className="fy-info-inline-action"
              data-info-card={card.chip.id}
              onClick={card.onOpen}
              title={card.chip.title ?? undefined}
              type="button"
            >
              {chatCardLabel(card.chip)}
            </button>
          )}
        </InfoRow>
      )}
    </InfoSection>
  );
}
