/**
 * TEMPORARY STAND-INS (r10 speed-up: this unit starts before its seams merge).
 *
 * `StepHost` is O1's real step contract (PR #2119: `@ferretry/kernel/contract`, with `remember()`); `ChoiceCards` is the shape P1 ships in `@ferretry/app` (§3, P1). When O1 and P1
 * merge, this file is deleted and the pages import the real ones: nothing else changes. It lives here, in this
 * plugin's own folder, and never in `packages/plugins/onboarding`.
 */
import type { ReactNode } from 'react';
import './onboarding.css';

/** What one plugin's earlier answers left for its later pages (this run only). */
export type StepSegmentMemory = Readonly<Record<string, string | number | boolean | undefined>>;

export interface StepHost {
  readonly phase: 'daemon' | 'client';
  readonly appliesTo: readonly { readonly daemon: string; readonly name: string }[];
  readonly segment: StepSegmentMemory;
  remember(patch: StepSegmentMemory): void;
  ready(): void;
  skip(why: 'not-needed' | 'already-set'): void;
  done(): void;
  busy(label: string | null): void;
  next(): void;
  back(): void;
}

/** What every page takes: the plugin's client, and the host the shell hands a step. */
export interface StepPageProps<Client> {
  readonly client: Client;
  readonly step?: StepHost | undefined;
}

export interface ChoiceOption<Id extends string> {
  readonly id: Id;
  readonly title: string;
  readonly line?: string;
}

/** A native radio group drawn as cards: arrow keys, one tab stop, the selected card carries a check. */
export function ChoiceCards<Id extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  readonly legend: string;
  readonly name: string;
  readonly options: readonly ChoiceOption<Id>[];
  readonly value: Id;
  readonly onChange: (id: Id) => void;
}): ReactNode {
  return (
    <fieldset className="cc-cards" data-choice-cards={name}>
      <legend className="sr-only">{legend}</legend>
      {options.map(option => (
        <label key={option.id} className="cc-card" data-choice={option.id}>
          <input
            type="radio"
            name={name}
            value={option.id}
            checked={value === option.id}
            onChange={() => onChange(option.id)}
          />
          <span className="cc-card__title">{option.title}</span>
          {option.line === undefined ? null : <span className="cc-card__line">{option.line}</span>}
        </label>
      ))}
    </fieldset>
  );
}
