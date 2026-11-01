import { afterEach, describe, expect, test } from 'bun:test';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { AgendaItemCard } from '../../../src/features/agenda/agenda-item-card.tsx';
import { agendaItem } from '../../support/agenda-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const marked = agendaItem('A1', {
  subject: 'Ship the release?',
  ask: {
    kind: 'multiple-choice',
    options: [
      { label: 'A **Send now**', description: 'Goes out today' },
      { label: 'B **Wait**', description: 'Hold until Monday' },
    ],
  },
} as never);

const draw = async (acted: unknown[] = []): Promise<HTMLElement> => {
  view = await mount(
    <AgendaItemCard
      busy={false}
      error={null}
      ferret="kai"
      item={marked}
      now={Date.parse('2026-08-01T12:00:00.000Z')}
      onAct={action => acted.push(action)}
      renderProse={text => <ChatProse text={text} />}
      swipeable={false}
    />,
  );
  return view.container;
};

describe('option labels that carry Markdown', () => {
  test('the "What I need from you" box shows no literal ** marks', async () => {
    const need = must((await draw()).querySelector<HTMLElement>('[data-agenda-need]'), 'the need box');
    expect(need.textContent).not.toContain('*');
    expect(need.textContent).toContain('Send now');
    expect(need.textContent).toContain('Wait');
    expect(need.textContent?.replaceAll(/\s+/gu, ' ')).not.toMatch(/\bA A\b|\bB B\b/u);
  });

  test('the answer buttons read as plain words, in their text, tooltip and accessible name', async () => {
    const chips = [...(await draw()).querySelectorAll<HTMLElement>('[data-agenda-answer][data-agenda-option]')];
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.textContent).not.toContain('*');
      expect(chip.getAttribute('title') ?? '').not.toContain('*');
      expect(chip.getAttribute('aria-label') ?? '').not.toContain('*');
    }
  });

  test('picking one still sends the label exactly as the ferret wrote it', async () => {
    const acted: unknown[] = [];
    const chip = must(
      [...(await draw(acted)).querySelectorAll<HTMLElement>('[data-agenda-option]')].find(
        node => node.getAttribute('data-agenda-option') === 'B **Wait**',
      ),
      'the Wait button',
    );
    await interact(() => chip.click());
    expect(JSON.stringify(acted)).toContain('B **Wait**');
  });
});
