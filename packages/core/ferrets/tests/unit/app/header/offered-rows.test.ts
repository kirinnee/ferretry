import { describe, expect, it } from 'bun:test';
import type { ActionsRowOffer } from '@ferretry/core-ferrets/contract';
import { Puzzle } from 'lucide-react';
import { contributionOf, offeredRowIcon } from '../../../../app/features/header/offered-rows.ts';
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

  it('draw with the icon of what they are, and a row the menu does not know keeps the generic one', () => {
    const ids = [
      'interrupt-turn',
      'add-mcp',
      'add-skills',
      'warden-investigate',
      'clear-stuck-messages',
      'dismiss-cancelled-messages',
      'open-queue',
    ];
    for (const id of ids) expect(offeredRowIcon(id), id).not.toBe(Puzzle);
    expect(new Set(ids.map(offeredRowIcon)).size, 'one icon per row').toBe(ids.length);
    expect(offeredRowIcon('something-new')).toBe(Puzzle);
    const sections = ferretActionSections([contributionOf({ ...interrupt, id: 'interrupt-turn' })], {} as never);
    expect(sections[0]?.entries[0]?.icon).toBe(offeredRowIcon('interrupt-turn'));
  });

  it('a withdrawn row leaves nothing behind', () => {
    expect(ferretActionSections([], {} as never)).toEqual([]);
  });
});
