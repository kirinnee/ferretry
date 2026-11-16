import { describe, expect, test } from 'bun:test';
import { LANE_TEMPLATES, type CardRef } from '../../../contract/index.ts';
import { boardAgendaContext } from '../../../daemon/adapters/agenda-context.ts';

/**
 * Board's half of `agenda.context:board` over the board's OWN lane templates and the contract's own
 * `laneForTrigger` (no lane function injected): "to test" is whatever lane `release.published` enters.
 */
const MACHINE = 'machine-1';
const WORKFLOW = 'design-first' as never;

const cardIn = (template: keyof typeof LANE_TEMPLATES, laneId: string) => ({
  card: { id: 'F9', laneId, workflow: WORKFLOW } as never,
  laneSet: { lanes: LANE_TEMPLATES[template].lanes, variants: LANE_TEMPLATES[template].variants } as never,
});

const contextOver = (cards: Record<string, ReturnType<typeof cardIn>>) =>
  boardAgendaContext({
    focusOf: async ferret => (ferret === 'lead' ? ({ id: 'F12' } as CardRef) : null),
    card: async id => cards[id],
    asking: async id => (id === 'F12' ? { ferret: 'lead', id: 'A7' } : undefined),
    machineId: () => MACHINE,
  });

describe('Board’s agenda.context provider over the real lane templates', () => {
  test('the focus card is the card the ferret works on, or null', async () => {
    const context = contextOver({});
    expect(await context.focusOf('lead')).toEqual({ id: 'F12' });
    expect(await context.focusOf('other')).toBeNull();
  });

  test('a card is in "to test" only while it sits in the lane release.published enters', async () => {
    const waiting = contextOver({ F9: cardIn('pr-release-verify', 'released') });
    expect(await waiting.inToTest({ id: 'F9' } as never)).toBe(true);
    const earlier = contextOver({ F9: cardIn('pr-release-verify', 'in-progress') });
    expect(await earlier.inToTest({ id: 'F9' } as never)).toBe(false);
    expect(await waiting.inToTest({ id: 'F404' } as never)).toBe(false);
  });

  test('a layout with no lane for the release, or a workflow it has no lanes for, has nothing to test', async () => {
    const noRelease = contextOver({ F9: cardIn('ops', 'fix') });
    expect(await noRelease.inToTest({ id: 'F9' } as never)).toBe(false);
    const noVariant = contextOver({
      F9: { ...cardIn('pr-release-verify', 'released'), laneSet: { lanes: [], variants: {} } as never },
    });
    expect(await noVariant.inToTest({ id: 'F9' } as never)).toBe(false);
  });

  test('a card read that fails, or a card with no lane set, is not "to test"', async () => {
    const failing = boardAgendaContext({
      focusOf: async () => null,
      card: async () => Promise.reject(new Error('store down')),
      asking: async () => undefined,
      machineId: () => MACHINE,
    });
    expect(await failing.inToTest({ id: 'F9' } as never)).toBe(false);
    const unset = contextOver({ F9: { ...cardIn('pr-release-verify', 'released'), laneSet: null as never } });
    expect(await unset.inToTest({ id: 'F9' } as never)).toBe(false);
  });

  test('a card of another machine is not answered here, and one of this machine is', async () => {
    const context = contextOver({ F9: cardIn('pr-release-verify', 'released') });
    expect(await context.inToTest({ id: 'F9', machineId: 'elsewhere' } as never)).toBe(false);
    expect(await context.asking({ id: 'F12', machineId: 'elsewhere' } as never)).toBeUndefined();
    expect(await context.inToTest({ id: 'F9', machineId: MACHINE } as never)).toBe(true);
  });

  test('asking names the agenda and item the gate is on; a failing read throws, never "not asking"', async () => {
    const context = contextOver({});
    expect(await context.asking({ id: 'F12' } as never)).toEqual({ sessionId: 'lead', id: 'A7' });
    expect(await context.asking({ id: 'F99' } as never)).toBeUndefined();
    const failing = boardAgendaContext({
      focusOf: async () => null,
      card: async () => undefined,
      asking: async () => Promise.reject(new Error('gate unreadable')),
      machineId: () => MACHINE,
    });
    await expect(failing.asking({ id: 'F12' } as never)).rejects.toThrow('gate unreadable');
  });
});
