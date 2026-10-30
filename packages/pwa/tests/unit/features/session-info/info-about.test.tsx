import { afterEach, describe, expect, it } from 'bun:test';
import { InfoAbout, type InfoAboutProps } from '../../../../src/features/session-info/info-about.tsx';
import type { ChatChip } from '../../../../src/lib/board-chat.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { sessionView } from '../../../support/sessions.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const view = sessionView('s1', { config: { teammate: 'hadi', mode: 'interactive' } });
const CARD: ChatChip = {
  kind: 'card',
  id: 'F18',
  ref: '&F18',
  title: 'Board system',
  lane: 'Plan/Design',
  activity: 'active',
  tone: 'ok',
};

const draw = async (props: Partial<InfoAboutProps> = {}): Promise<HTMLElement> => {
  mounted = await mount(<InfoAbout subFerrets={[]} view={view} {...props} />);
  return mounted.container;
};
const row = (root: HTMLElement, label: string) =>
  must(root.querySelector<HTMLElement>(`[data-info-row="${label}"]`), `${label} row`);
const rowLabels = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-info-row]')].map(node => node.getAttribute('data-info-row'));

describe('Info › About this ferret', () => {
  it('is a labelled block that always has the sub-ferrets and capabilities rows', async () => {
    const root = await draw({ view: sessionView('s1', { config: { teammate: 'hadi', mode: 'auto', pack: false } }) });
    expect(root.querySelector('section[aria-label="About this ferret"]')).not.toBeNull();
    expect(rowLabels(root)).toEqual(['Sub-ferrets (0)', 'Capabilities']);
    expect(row(root, 'Sub-ferrets (0)').textContent).toContain('None');
    expect(row(root, 'Capabilities').textContent).toContain('None on');
  });

  it('counts the active sub-ferrets and opens one when it is clicked', async () => {
    const opened: string[] = [];
    const running = sessionView('kid', { config: { parent: 's1', name: 'Kid' } });
    const root = await draw({ subFerrets: [running], onOpenSession: id => opened.push(id) });
    expect(rowLabels(root)).toContain('Sub-ferrets (1)');
    const open = must(root.querySelector<HTMLButtonElement>('[data-sub-ferret-open="kid"]'), 'sub-ferret link');
    expect(open.textContent).toBe('Kid');
    await interact(() => open.click());
    expect(opened).toEqual(['kid']);
  });

  it('names a sub-ferret without a link when the host cannot open sessions', async () => {
    const root = await draw({ subFerrets: [sessionView('kid', { config: { parent: 's1', name: 'Kid' } })] });
    expect(root.querySelector('[data-sub-ferret-open]')).toBeNull();
    expect(row(root, 'Sub-ferrets (1)').textContent).toContain('Kid');
  });

  it('draws the card with its lane, and opens it when clicked', async () => {
    let opened = 0;
    const root = await draw({
      card: {
        chip: CARD,
        onOpen: () => {
          opened += 1;
        },
      },
    });
    const card = must(root.querySelector<HTMLButtonElement>('[data-info-card="F18"]'), 'card button');
    expect(card.textContent).toBe('&F18 (Plan/Design)');
    expect(card.getAttribute('title')).toBe('Board system');
    expect(root.querySelector('[data-info-open-board]')).toBeNull();
    await interact(() => card.click());
    expect(opened).toBe(1);
  });

  it('says "No card" for a ferret with none, and has no Card row when the host has no board', async () => {
    const none = await draw({ card: { chip: { kind: 'none' }, onOpen: () => undefined } });
    expect(row(none, 'Card').textContent).toContain('No card');
    expect(none.querySelector('[data-info-card="none"]')).not.toBeNull();
    await mounted?.unmount();
    const bare = await draw();
    expect(rowLabels(bare)).not.toContain('Card');
  });

  it('opens the board from the card row when the host can', async () => {
    let boards = 0;
    const root = await draw({
      card: {
        chip: CARD,
        onOpen: () => undefined,
        onOpenBoard: () => {
          boards += 1;
        },
      },
    });
    const button = must(root.querySelector<HTMLButtonElement>('[data-info-open-board]'), 'open board');
    expect(button.textContent).toBe('Open board');
    await interact(() => button.click());
    expect(boards).toBe(1);
  });

  it('still offers the board for a ferret with no card, and none when the host has no handler', async () => {
    let boards = 0;
    const none = await draw({
      card: { chip: { kind: 'none' }, onOpen: () => undefined, onOpenBoard: () => (boards += 1) },
    });
    await interact(() => must(none.querySelector<HTMLButtonElement>('[data-info-open-board]'), 'open board').click());
    expect(boards).toBe(1);
    await mounted?.unmount();
    const without = await draw({ card: { chip: CARD, onOpen: () => undefined } });
    expect(without.querySelector('[data-info-open-board]')).toBeNull();
  });

  it('shows the capabilities that are on, and turns one off from here', async () => {
    const taps: Array<[string, boolean]> = [];
    const root = await draw({
      switches: {
        learning: false,
        hypermedia: true,
        pack: true,
        onToggle: (section, next) => taps.push([section, next]),
      },
    });
    const marks = [...root.querySelectorAll('[data-switch-mark]')].map(node => node.getAttribute('data-switch-mark'));
    expect(marks).toEqual(['hypermedia', 'pack']);
    await interact(() =>
      must(root.querySelector<HTMLButtonElement>('button[data-switch-mark="pack"]'), 'pack toggle').click(),
    );
    expect(taps).toEqual([['pack', false]]);
  });

  it('draws the marks as plain icons when the reader cannot switch them', async () => {
    const root = await draw({ switches: { learning: false, hypermedia: false, pack: true } });
    expect(root.querySelector('[data-switch-mark="pack"]')).not.toBeNull();
    expect(root.querySelector('[data-switch-marks] button')).toBeNull();
  });

  it('has a Restart button that calls onRestart, and says so while it works', async () => {
    let finish: () => void = () => undefined;
    let calls = 0;
    const root = await draw({
      onRestart: () => {
        calls += 1;
        return new Promise<void>(resolve => {
          finish = resolve;
        });
      },
    });
    const restart = () => must(root.querySelector<HTMLButtonElement>('[data-info-restart]'), 'restart button');
    expect(restart().textContent).toBe('Restart');
    await interact(() => restart().click());
    expect(calls).toBe(1);
    expect(restart().textContent).toBe('Restarting…');
    expect(restart().disabled).toBe(true);
    await interact(() => finish());
    expect(restart().textContent).toBe('Restart');
    expect(restart().disabled).toBe(false);
  });

  it('has no Restart button for a reader who may not restart the ferret', async () => {
    const root = await draw();
    expect(root.querySelector('[data-info-restart]')).toBeNull();
  });

  it('holds the agenda in its own row, and none when the ferret is not in agenda mode', async () => {
    const root = await draw({ agenda: <b data-test-agenda="">2 need you</b> });
    const slot = must(root.querySelector('[data-info-agenda]'), 'agenda slot');
    expect(row(root, 'Agenda').contains(slot)).toBe(true);
    expect(slot.textContent).toBe('2 need you');
    await mounted?.unmount();
    for (const none of [undefined, null]) {
      const empty = await draw({ agenda: none });
      expect(empty.querySelector('[data-info-agenda]')).toBeNull();
      expect(rowLabels(empty)).not.toContain('Agenda');
      await mounted?.unmount();
    }
  });
});
