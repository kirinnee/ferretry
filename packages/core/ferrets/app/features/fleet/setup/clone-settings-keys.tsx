/**
 * A repeat copy's settings, key by key (`clone-settings-merge.ts`): each setting that differs between the two
 * machines, what each side has, and the choice. A setting changed on BOTH machines has **no choice made for it**:
 * the person picks, and Copy stays off until every one is picked.
 *
 * Values are configuration text. A `${secret:NAME}` stays a reference: no route returns a secret value, so there
 * is none here to show.
 */

import type { CloneKeyChoice } from '@ferretry/plugin-runtimes/contract';
import { Badge } from '@ferretry/app';
import {
  choiceFor,
  documentLabel,
  outcomeWords,
  type ReviewedSettings,
  type SettingsPicks,
  takeWords,
} from './clone-settings-merge.ts';
import { LoosensBadge } from './clone-loosens-badge.tsx';
import { CheckChoices, RadioChoices, SetupNote, SetupSection } from './setup-ui.tsx';

function Value({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <span className="flex min-w-0 gap-2 text-cell">
      <span className="w-20 shrink-0 text-meta text-muted">{label}</span>
      <span className="[overflow-wrap:anywhere] font-mono text-fg">{text}</span>
    </span>
  );
}

function KeyRow({
  document,
  row,
  picks,
  source,
  machineName,
  onPick,
}: {
  readonly document: ReviewedSettings;
  readonly row: ReviewedSettings['keys'][number];
  readonly picks: SettingsPicks;
  readonly source: string;
  readonly machineName: string;
  readonly onPick: (path: string, key: string, choice: CloneKeyChoice) => void;
}) {
  const choice = choiceFor(document.path, row, picks);
  const name = `${document.path}:${row.key}`;
  return (
    <div className="kt-panel flex min-w-0 flex-col gap-2 p-panel" data-clone-key={name} data-outcome={row.outcome}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="[overflow-wrap:anywhere] font-mono text-row font-semibold text-fg">{row.key}</span>
        <Badge tone={row.outcome === 'both' ? 'warn' : 'pend'}>{outcomeWords(row.outcome, source)}</Badge>
        {row.loosens === true ? <LoosensBadge machineName={machineName} data-clone-key-loosens="" /> : null}
      </span>
      <Value label={machineName} text={row.mine ?? 'not set'} />
      <Value label={source} text={row.theirs ?? 'not set'} />
      {row.outcome === 'mine' ? (
        <span className="text-cell text-muted">Kept as {machineName} has it.</span>
      ) : row.outcome === 'both' ? (
        <RadioChoices
          legend={`${row.key}: which one to keep`}
          name={`clone-key-${name}`}
          value={choice ?? null}
          onChoose={value => onPick(document.path, row.key, value)}
          options={[
            { id: 'keep', title: `Keep ${machineName}’s` },
            { id: 'take', title: `Use ${source}’s` },
          ]}
        />
      ) : (
        <CheckChoices
          legend={`${row.key}: take it`}
          legendHidden
          name={`clone-key-${name}`}
          values={choice === 'take' ? ['take'] : []}
          onToggle={(_id, on) => onPick(document.path, row.key, on ? 'take' : 'keep')}
          options={[{ id: 'take', title: takeWords(row, source) }]}
        />
      )}
    </div>
  );
}

/** Every setting that differs, per document, with the choice for each. Nothing is shown for a document that is the same. */
export function CloneSettingsKeys({
  review,
  picks,
  source,
  machineName,
  onPick,
}: {
  readonly review: readonly ReviewedSettings[];
  readonly picks: SettingsPicks;
  readonly source: string;
  readonly machineName: string;
  readonly onPick: (path: string, key: string, choice: CloneKeyChoice) => void;
}) {
  const shown = review.filter(document => document.refused !== undefined || document.keys.length > 0);
  if (shown.length === 0) return null;
  return (
    <SetupSection title="Settings that differ" name="clone-setting-keys">
      <p className="m-0 text-cell leading-base text-muted">
        Only the settings that differ are listed. A setting you changed here that {source} did not change stays as you
        have it. For a setting changed on both, you choose.
      </p>
      {shown.map(document => (
        <div key={document.path} className="flex min-w-0 flex-col gap-2" data-clone-setting-document={document.path}>
          <h5 className="m-0 text-meta font-semibold text-fg">
            {documentLabel(document.path)}
            {document.isNew === true ? ` — not on ${machineName} yet` : ''}
          </h5>
          {document.refused === undefined ? null : (
            <SetupNote live tone="err" name={`refused-${document.path}`} title={`${document.path} can’t be copied`}>
              <span>{document.refused}</span>
            </SetupNote>
          )}
          {document.keys.map(row => (
            <KeyRow
              key={row.key}
              document={document}
              row={row}
              picks={picks}
              source={source}
              machineName={machineName}
              onPick={onPick}
            />
          ))}
        </div>
      ))}
    </SetupSection>
  );
}
