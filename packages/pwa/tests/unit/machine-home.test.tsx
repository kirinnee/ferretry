import { describe, expect, it } from 'bun:test';
import { MachineHome, type MachineHomeProps } from '../../src/components/machine-home.tsx';
import { TOP_FERRETS } from '../../src/components/machine-home-model.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { mount } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const alpha = daemonId('alpha');
const interactive = (id: string, state: Parameters<typeof sessionView>[1] = {}) =>
  sessionView(id, { ...state, config: { mode: 'interactive', ...state.config } });

const props = (overrides: Partial<MachineHomeProps> = {}): MachineHomeProps => ({
  daemonId: alpha,
  machineName: 'Mac mini',
  sessions: [],
  toTest: 0,
  spendTodayUsd: 0,
  health: { tone: 'ok', word: 'Healthy', detail: 'Fleet checks · swept now' },
  now: NOW,
  ...overrides,
});

const tile = (container: Element, label: string): Element | null =>
  container.querySelector(`[data-home-tile="${label}"]`);

describe('MachineHome', () => {
  it('shows the five tiles, each a real link to the place that owns the number', async () => {
    const { container } = await mount(<MachineHome {...props()} />);

    const hrefs = ['Running', 'Needs you', 'To test', 'Spend today', 'Health'].map(label =>
      tile(container, label)?.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      '/d/alpha/sessions',
      '/d/alpha/inbox',
      '/d/alpha/board?activity=to_test&machine=alpha',
      '/d/alpha/analytics',
      '/d/alpha/warden',
    ]);
  });

  it('says a dash, never a false zero, until a read has landed', async () => {
    const { container } = await mount(
      <MachineHome {...props({ sessions: null, toTest: null, spendTodayUsd: null, health: null })} />,
    );

    for (const label of ['Running', 'Needs you', 'To test', 'Spend today', 'Health'])
      expect(tile(container, label)?.textContent).toContain('—');
  });

  it('lists only the top ferrets and points at every session', async () => {
    const sessions = Array.from({ length: TOP_FERRETS + 4 }, (_, index) => interactive(`s${index}`));
    const { container } = await mount(<MachineHome {...props({ sessions })} />);

    expect(container.querySelectorAll('[data-home-ferret]')).toHaveLength(TOP_FERRETS);
    const all = container.querySelector('[data-home-all-sessions]');
    expect(all?.getAttribute('href')).toBe('/d/alpha/sessions');
    expect(all?.textContent).toContain(`All ${TOP_FERRETS + 4} sessions`);
  });

  it('opens a ferret at its own session page', async () => {
    const { container } = await mount(<MachineHome {...props({ sessions: [interactive('abc')] })} />);

    expect(container.querySelector('[data-home-ferret="abc"]')?.getAttribute('href')).toBe('/d/alpha/session/abc');
  });

  it('lights Needs you only while something waits on the owner', async () => {
    const waiting = interactive('ask', {
      state: {
        status: 'awaiting_user',
        attention: { open: 2, first: 'A1', ask: 'Go?', latestAt: '2026-10-16T11:59:00.000Z' } as never,
      },
    });
    const quiet = await mount(<MachineHome {...props({ sessions: [interactive('a')] })} />);
    const busy = await mount(<MachineHome {...props({ sessions: [waiting] })} />);

    expect(tile(quiet.container, 'Needs you')?.textContent).toContain('all clear');
    expect(tile(busy.container, 'Needs you')?.textContent).toContain('open Inbox');
  });

  it('says plainly when no interactive ferret is running', async () => {
    const { container } = await mount(<MachineHome {...props({ sessions: [] })} />);

    expect(container.textContent).toContain('No interactive ferrets are running here.');
    expect(container.querySelectorAll('[data-home-ferret]')).toHaveLength(0);
  });

  it('names the machine in the page heading', async () => {
    const { container } = await mount(<MachineHome {...props()} />);

    expect(container.querySelector('h1')?.textContent).toBe('Mac mini');
  });
});
