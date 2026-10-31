/**
 * REVISIONS: how the item changed, version by version, newest first — v1 as first raised, then one version per
 * edit with each field it changed shown before → after. Read off the item's own `revisions`, so an older daemon
 * has all of it; nothing is requested.
 */

import type { AgendaItem } from '@ferretry/protocol';
import {
  type ItemVersion,
  itemVersions,
  revisionAuthor,
  revisionStamp,
  type VersionChange,
} from '../../lib/agenda-revisions.ts';
import { PointForm } from './agenda-brief.tsx';

function Side({ word, text }: { readonly word: 'Before' | 'After'; readonly text: string | null }) {
  return (
    <div className="fy-item-revisions__side" data-side={word.toLowerCase()}>
      <span className="fy-item-revisions__word">{word}</span>
      {text === null ? <p className="fy-item-revisions__empty m-0">empty</p> : <PointForm text={text} />}
    </div>
  );
}

function Change({ change }: { readonly change: VersionChange }) {
  return (
    <div className="fy-item-revisions__change" data-field={change.field}>
      <h5 className="fy-item-revisions__field m-0">{change.label}</h5>
      <div className="fy-item-revisions__pair">
        <Side text={change.before} word="Before" />
        <Side text={change.after} word="After" />
      </div>
    </div>
  );
}

function Version({ version, current, ferret, now }: VersionProps) {
  const first = version.at === null || version.by === null;
  return (
    <li className="fy-item-revisions__version" data-agenda-version={version.number}>
      <p className="fy-item-revisions__head m-0">
        <strong>v{version.number}</strong>
        {first ? (
          <span>as first raised</span>
        ) : (
          <>
            <span>{version.by === 'agent' ? ferret : revisionAuthor(version.by)}</span>
            <time dateTime={version.at}>{revisionStamp(version.at, now)}</time>
          </>
        )}
        {current ? <span className="fy-item-revisions__current">current</span> : null}
      </p>
      {version.changes.map(change => (
        <Change change={change} key={change.field} />
      ))}
    </li>
  );
}

interface VersionProps {
  readonly version: ItemVersion;
  readonly current: boolean;
  readonly ferret: string;
  readonly now: number;
}

export function AgendaRevisions({
  item,
  ferret,
  now,
}: {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now: number;
}) {
  if ((item.revisions?.length ?? 0) === 0) return null;
  return (
    <section aria-label="Revisions" className="fy-item-revisions" data-agenda-revisions="">
      <h3 className="fy-item-revisions__title m-0">Revisions</h3>
      <ol className="fy-item-revisions__list">
        {itemVersions(item).map((version, index) => (
          <Version current={index === 0} ferret={ferret} key={version.number} now={now} version={version} />
        ))}
      </ol>
    </section>
  );
}
