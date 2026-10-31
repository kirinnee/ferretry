/**
 * WHAT THE OWNER HAS PICKED ON A FORM CARD, kept apart from the card so the card and the composer's one Send read the
 * same picks. A pick lives per open item (`formKey`), starts on the asker's recommendation, and is forgotten once the
 * form is sent. The words and the rules for what a form answer is are the protocol's (`agenda-form.ts`).
 */

import type { AgendaFormField } from '@ferretry/protocol';
import { useSyncExternalStore } from 'react';

/** The values picked on each field, by field id: one for a pick-one or yes/no, any for a pick-many. */
export type FormPicks = Readonly<Record<string, readonly string[]>>;

/** The picks a form starts with: the asker's recommended value on every field that names one. */
export const recommendedPicks = (fields: readonly AgendaFormField[]): FormPicks =>
  Object.fromEntries(
    fields.flatMap(field =>
      field.recommended === undefined ? [] : [[field.id, field.recommended.map(value => value.trim())] as const],
    ),
  );

/** `values` with one field set to `next` (an empty list clears it). */
export const withPick = (picks: FormPicks, field: string, next: readonly string[]): FormPicks => {
  const { [field]: _gone, ...rest } = picks;
  return next.length === 0 ? rest : { ...rest, [field]: next };
};

/** Picking one option: a pick-one holds it alone, a pick-many toggles it among the others. */
export const toggled = (current: readonly string[], value: string, many: boolean): readonly string[] =>
  many ? (current.includes(value) ? current.filter(each => each !== value) : [...current, value]) : [value];

export class AgendaFormStore {
  readonly #picks = new Map<string, FormPicks>();
  readonly #asked = new Map<string, string>();
  readonly #changes = new Map<string, number>();
  readonly #listeners = new Set<() => void>();

  /** The picks of this form; the recommendation until the owner changes one. */
  picks(key: string, fields: readonly AgendaFormField[]): FormPicks {
    const known = this.#picks.get(key);
    if (known !== undefined) return known;
    const start = recommendedPicks(fields);
    this.#picks.set(key, start);
    return start;
  }

  set(key: string, fields: readonly AgendaFormField[], field: string, next: readonly string[]): void {
    this.#picks.set(key, withPick(this.picks(key, fields), field, next));
    this.#asked.delete(key);
    this.#changes.set(key, this.changes(key) + 1);
    this.#emit();
  }

  /** How many times the owner has changed a pick on this form: the composer clears a stale "not answered" line on it. */
  changes(key: string): number {
    return this.#changes.get(key) ?? 0;
  }

  /** What the owner was last asked about when Send found required fields empty; sending again as asked goes through. */
  asked(key: string): string | undefined {
    return this.#asked.get(key);
  }

  markAsked(key: string, signature: string): void {
    this.#asked.set(key, signature);
  }

  forget(key: string): void {
    this.#picks.delete(key);
    this.#asked.delete(key);
    this.#changes.delete(key);
    this.#emit();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** The page's one store of form picks. */
export const agendaForms = new AgendaFormStore();

/** How often the picks of the form `key` names have been changed, redrawn when one is. */
export const useFormChanges = (key: string): number =>
  useSyncExternalStore(
    agendaForms.subscribe,
    () => agendaForms.changes(key),
    () => 0,
  );

/** The picks of the form `key` names, redrawn when one changes. */
export const useFormPicks = (key: string, fields: readonly AgendaFormField[]): FormPicks =>
  useSyncExternalStore(
    agendaForms.subscribe,
    () => agendaForms.picks(key, fields),
    () => recommendedPicks(fields),
  );
