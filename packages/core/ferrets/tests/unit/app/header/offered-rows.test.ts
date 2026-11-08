import { describe, expect, it } from 'bun:test';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { contributionOf } from '../../../../app/features/header/offered-rows.ts';
import { ferretActionSections } from '../../../../app/features/header/registry.ts';

const interrupt: ActionsRowOffer = {
  kind: 'confirm',
  id: 'interrupt',
  label: 'Interrupt',
  group: 'ferret',
  order: 15,
  danger: true,
  question: 'Interrupt Hadi?',
  consequence: 'It stops its current turn.',
  confirmLabel: 'Interrupt',
  run: () => undefined,
};
const fork: ActionsRowOffer = {
  kind: 'run',
  id: 'fork',
  label: 'Fork into a new ferret…',
  group: 'ferret',
  order: 25,
  detail: 'later',
  unavailable: 'Send it a message first.',
  run: () => undefined,
};

describe('rows another plugin offers the Actions menu', () => {
  it('draw as the menu’s own rows, in their group and order, carrying what the offer said', () => {
    const sections = ferretActionSections([contributionOf(fork), contributionOf(interrupt)], {} as never);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries.map(entry => entry.id)).toEqual(['interrupt', 'fork']);
    expect(sections[0]?.entries[0]).toMatchObject({
      kind: 'confirm',
      danger: true,
      question: 'Interrupt Hadi?',
      confirmLabel: 'Interrupt',
    });
    expect(sections[0]?.entries[1]).toMatchObject({
      kind: 'run',
      detail: 'later',
      unavailable: 'Send it a message first.',
    });
  });

  it('a withdrawn row leaves nothing behind', () => {
    expect(ferretActionSections([], {} as never)).toEqual([]);
  });
});
