/**
 * ONE conversation row, shared by New session › Continue and "Import conversations", so a conversation
 * reads the same wherever it is listed:
 *
 *   avatar   the ferret's initial (with a dot saying whether it is live) when a ferret keeps it, else the
 *            CLI's own mark — the row's colour, readable before any word is
 *   title    what it is about: the conversation's name, else the first real thing the owner said
 *   preview  the first message under a name, or the latest one under an unnamed first message
 *   meta     coloured marks — the ferret, the CLI — then the folder (or "scratch"), turns and model
 *
 * Every colour comes from a source token (`--fy-src-*` in `session-screens.css`) mixed with the theme's
 * own ink and surface, so each theme family and mode keeps its contrast.
 */

import type { Harness, ImportableConversation } from '@ferretry/protocol';
import { conversationFolder } from '@ferretry/protocol';
import { Asterisk, CodeXml, FlaskConical, Folder, Laptop, PawPrint } from 'lucide-react';
import type { ReactNode } from 'react';
import { relativeTime, sessionStatusLabel } from '../../../lib/session-screens.ts';
import { HARNESS_SHORT } from '../credentials/credentials-model.ts';
import { conversationHeadline, type FerretMark, ferretState } from './conversation-picker-model.ts';

/** Who a row belongs to, as its colour says it. */
export type ConversationSourceMark = 'ferretry' | 'computer' | Harness;

const HARNESS_ICON: Readonly<Record<Harness, typeof Asterisk>> = { claude: Asterisk, codex: CodeXml };

const MARK_ICON: Readonly<Record<ConversationSourceMark, typeof Asterisk>> = {
  ...HARNESS_ICON,
  ferretry: PawPrint,
  computer: Laptop,
};

/** A mark's icon: the CLI's own, a paw for Ferretry, or a laptop for what is only on this computer. */
export function SourceIcon({ source, size = 12 }: { readonly source: ConversationSourceMark; readonly size?: number }) {
  const Icon = MARK_ICON[source];
  return <Icon size={size} aria-hidden="true" className="shrink-0" />;
}

/** A coloured, iconed tag naming a CLI or a ferret. */
export function SourceBadge({
  source,
  children,
  data,
}: {
  readonly source: ConversationSourceMark;
  readonly children: ReactNode;
  readonly data?: Readonly<Record<`data-${string}`, string>>;
}) {
  return (
    <span className="fy-src-badge" data-source={source} {...data}>
      <SourceIcon source={source} />
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** The row's leading mark: a ferret's initial with its state dot, or the CLI's icon. */
function Avatar({ harness, ferret }: { readonly harness: Harness; readonly ferret: FerretMark | undefined }) {
  if (ferret === undefined)
    return (
      <span className="fy-convo-avatar" data-source={harness} aria-hidden="true">
        <SourceIcon source={harness} size={16} />
      </span>
    );
  const state = ferretState(ferret.status);
  return (
    <span className="fy-convo-avatar" data-source="ferretry" aria-hidden="true">
      <span className="fy-convo-avatar__initial">{ferret.name.slice(0, 1).toUpperCase()}</span>
      {state === undefined ? null : <span className="fy-convo-avatar__dot" data-state={state} />}
    </span>
  );
}

/** The ferret's tag: its name, and its status when the app has read it. */
function FerretBadge({ ferret }: { readonly ferret: FerretMark }) {
  return (
    <SourceBadge source="ferretry" data={{ 'data-conversation-ferret': ferret.id }}>
      <span className="sr-only">Ferret </span>
      {ferret.name}
      {ferret.status === undefined ? null : (
        <span className="fy-src-badge__state"> · {sessionStatusLabel(ferret.status)}</span>
      )}
    </SourceBadge>
  );
}

/** The folder as a row says it: its own name, or a "scratch" tag for a throwaway one. */
function FolderMark({ project }: { readonly project: string }) {
  const folder = conversationFolder(project);
  return (
    <span className="fy-convo-folder" title={project} data-conversation-folder={folder.scratch ? 'scratch' : ''}>
      {folder.scratch ? (
        <span className="fy-convo-scratch">
          <FlaskConical size={11} aria-hidden="true" className="shrink-0" />
          scratch
        </span>
      ) : (
        <Folder size={11} aria-hidden="true" className="shrink-0" />
      )}
      {folder.name === undefined ? null : <span className="min-w-0 truncate font-mono">{folder.name}</span>}
    </span>
  );
}

/** The row's frame: the avatar beside the title line, the preview lines and the meta line. */
function Card({
  harness,
  ferret,
  title,
  named,
  age,
  lines,
  meta,
}: {
  readonly harness: Harness;
  readonly ferret: FerretMark | undefined;
  readonly title: string;
  readonly named: boolean;
  readonly age: string;
  readonly lines: ReactNode;
  readonly meta: ReactNode;
}) {
  return (
    <span className="fy-convo-card">
      <Avatar harness={harness} ferret={ferret} />
      <span className="fy-convo-body">
        <span className="fy-convo-head">
          <span className="fy-convo-title" title={title} data-conversation-name={named ? '' : undefined}>
            {title}
          </span>
          <span className="fy-convo-age" data-conversation-age="">
            {age}
          </span>
        </span>
        {lines}
        <span className="fy-convo-meta">{meta}</span>
      </span>
    </span>
  );
}

/**
 * A conversation: headed by its name (else its first real message), the first message under a name or
 * the latest one under an unnamed first message, then the ferret that keeps it, its CLI, folder, turns
 * and model.
 */
export function ConversationLines({
  row,
  now,
  ferret,
}: {
  readonly row: ImportableConversation;
  readonly now: number;
  /** The ferret that keeps it, when one does. */
  readonly ferret?: FerretMark;
}) {
  const { headline, secondary, named } = conversationHeadline(row);
  const turns = `${row.turns}${row.turnsAtLeast === true ? '+' : ''} ${row.turns === 1 ? 'turn' : 'turns'}`;
  return (
    <Card
      harness={row.harness}
      ferret={ferret}
      title={headline}
      named={named}
      age={relativeTime(row.lastActivityAt, now)}
      lines={
        <>
          {secondary === undefined ? null : (
            <span className="fy-convo-line" title={secondary} data-conversation-first="">
              {secondary}
            </span>
          )}
          {named || row.latest === undefined ? null : (
            <span className="fy-convo-line" title={row.latest} data-conversation-latest="">
              <span className="sr-only">Latest: </span>
              {row.latest}
            </span>
          )}
        </>
      }
      meta={
        <>
          {ferret === undefined ? null : <FerretBadge ferret={ferret} />}
          <SourceBadge source={row.harness} data={{ 'data-conversation-harness': row.harness }}>
            {HARNESS_SHORT[row.harness]}
          </SourceBadge>
          {row.keptIn === 'computer' ? (
            <SourceBadge source="computer" data={{ 'data-conversation-computer': '' }}>
              On this computer
            </SourceBadge>
          ) : null}
          <FolderMark project={row.project} />
          <span className="fy-convo-facts">
            {turns}
            {row.model === undefined ? null : ` · ${row.model}`}
          </span>
        </>
      }
    />
  );
}

/** A ferret whose conversation the listing does not have: its name, how it stopped, its CLI and folder. */
export function FerretLines({
  ferret,
  harness,
  cwd,
  lastActivityAt,
  now,
}: {
  readonly ferret: FerretMark;
  readonly harness: Harness;
  readonly cwd: string;
  readonly lastActivityAt: string;
  readonly now: number;
}) {
  return (
    <Card
      harness={harness}
      ferret={ferret}
      title={ferret.name}
      named
      age={relativeTime(lastActivityAt, now)}
      lines={null}
      meta={
        <>
          <FerretBadge ferret={ferret} />
          <SourceBadge source={harness} data={{ 'data-conversation-harness': harness }}>
            {HARNESS_SHORT[harness]}
          </SourceBadge>
          <FolderMark project={cwd} />
        </>
      }
    />
  );
}

/** "All · Ferretry · On this computer · Claude · Codex": one pressed chip, each in its source's colour. */
export function SourceChips({
  options,
  value,
  onChoose,
}: {
  readonly options: readonly { readonly id: 'all' | ConversationSourceMark; readonly label: string }[];
  readonly value: 'all' | ConversationSourceMark;
  readonly onChoose: (value: 'all' | ConversationSourceMark) => void;
}) {
  return (
    <div role="toolbar" aria-label="Show" data-segmented="source" className="fy-src-chips">
      {options.map(option => (
        <button
          key={option.id}
          type="button"
          aria-pressed={option.id === value}
          data-segment={option.id}
          data-source={option.id}
          onClick={() => onChoose(option.id)}
          className="fy-src-chip"
        >
          {option.id === 'all' ? null : <SourceIcon source={option.id} />}
          {option.label}
        </button>
      ))}
    </div>
  );
}
