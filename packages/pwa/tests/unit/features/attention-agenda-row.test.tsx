import { describe, expect, it } from 'bun:test';
import { AttentionAgendaRow } from '../../../src/features/attention/attention-agenda-row.tsx';
import type { InboxAction } from '../../../src/lib/attention-answers.ts';
import { attentionItem, choices } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

const NOW = Date.parse('2026-10-29T10:00:00.000Z');

const pick = <T extends HTMLElement>(view: Mounted, selector: string, what: string): T =>
  must(view.container.querySelector<T>(selector), what);

const chips = (view: Mounted): HTMLElement[] => [
  ...view.container.querySelectorAll<HTMLElement>('[data-attention-chip]'),
];

const row = (
  extra: Record<string, unknown> = {},
  props: { referenced?: boolean; onAct?: (a: InboxAction) => void; onOpen?: () => void; onAddReply?: () => void } = {},
) =>
  mount(
    <AttentionAgendaRow
      ferret="Johnnie"
      item={attentionItem('A5', {
        subject: 'Which database?',
        title: 'Pick the database',
        ask: choices('SQLite', 'Postgres', 'Neither'),
        ...extra,
      })}
      now={NOW}
      onAct={props.onAct ?? (() => undefined)}
      onAddReply={props.onAddReply ?? (() => undefined)}
      onOpen={props.onOpen ?? (() => undefined)}
      referenced={props.referenced ?? false}
    />,
  );

describe('the agenda row', () => {
  it('is one title, no pill for a plain needs-you, up to three option chips and a reply button', async () => {
    const view = await row();
    expect(pick(view, '[data-attention-row-open]', 'title').textContent).toBe('Pick the database');
    expect(view.container.querySelector('[data-agenda-status]')).toBeNull();
    expect(chips(view).map(chip => chip.textContent)).toEqual(['SQLite', 'Postgres', 'Neither']);
    expect(pick(view, '[data-attention-add-reply]', 'reply').textContent).toContain('reply');
    await view.unmount();
  });

  it('opens on the title and adds the reply chip on "＋ reply"', async () => {
    const calls: string[] = [];
    const view = await row({}, { onOpen: () => calls.push('open'), onAddReply: () => calls.push('reply') });
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-row-open]', 'title').click());
    await interact(() => pick<HTMLButtonElement>(view, '[data-attention-add-reply]', 'reply').click());
    expect(calls).toEqual(['open', 'reply']);
    await view.unmount();
  });

  it('says "re: added" and is pressed once the composer references it', async () => {
    const view = await row({}, { referenced: true });
    const reply = pick(view, '[data-attention-add-reply]', 'reply');
    expect(reply.textContent).toContain('re: added');
    expect(reply.getAttribute('aria-pressed')).toBe('true');
    await view.unmount();
  });

  it('tags the recommended chip, in words for a screen reader', async () => {
    const view = await row({ recommendation: { decision: 'Postgres', why: 'It scales.' } });
    const tagged = view.container.querySelectorAll('[data-attention-chip][data-recommended]');
    expect(tagged.length).toBe(1);
    expect(tagged[0]?.textContent).toContain('Postgres');
    expect(tagged[0]?.textContent).toContain('recommended');
    expect(chips(view)[0]?.textContent).toContain('Postgres');
    await view.unmount();
  });

  it('hands a chip press up as the answer, and not while an answer is on its way', async () => {
    const acts: InboxAction[] = [];
    const view = await row({}, { onAct: a => acts.push(a) });
    await interact(() => chips(view)[0]?.click());
    expect(acts).toHaveLength(1);
    expect(acts[0]?.kind).toBe('respond');
    await view.unmount();
    const busy = await mount(
      <AttentionAgendaRow
        busy
        ferret="J"
        item={attentionItem('A6', { ask: choices('A', 'B') })}
        onAct={() => undefined}
        onAddReply={() => undefined}
        onOpen={() => undefined}
        referenced={false}
      />,
    );
    expect(chips(busy).every(chip => (chip as HTMLButtonElement).disabled)).toBe(true);
    await busy.unmount();
  });

  it('dims a ferret’s-turn row, says who it is with and offers no answers', async () => {
    const view = await row({ waitingOn: 'ferret' });
    expect(pick(view, '[data-attention-agenda-row]', 'row').hasAttribute('data-agenda-dimmed')).toBe(true);
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('With Johnnie');
    expect(chips(view)).toHaveLength(0);
    await view.unmount();
  });

  it('carries what it blocks in the pill', async () => {
    const view = await row({ blockingNow: true });
    expect(pick(view, '[data-agenda-status]', 'pill').getAttribute('data-tone')).toBe('blocking');
    expect(pick(view, '[data-agenda-status]', 'pill').textContent).toBe('Blocking now');
    await view.unmount();
  });

  it('draws a notification with no pill and no options — its one chip is Clear', async () => {
    const acts: InboxAction[] = [];
    const view = await row({ notice: true, ask: undefined }, { onAct: a => acts.push(a) });
    expect(view.container.querySelector('[data-agenda-status]')).toBeNull();
    expect(chips(view).map(chip => chip.textContent)).toEqual(['Clear']);
    await interact(() => chips(view)[0]?.click());
    expect(acts).toEqual([{ kind: 'resolve', label: 'Clear' }]);
    await view.unmount();
  });

  it('gives every press target a name', async () => {
    const view = await row();
    for (const button of view.container.querySelectorAll('button'))
      expect(
        (button.textContent ?? '').trim().length + (button.getAttribute('aria-label') ?? '').length,
      ).toBeGreaterThan(0);
    expect(view.container.querySelector('fieldset')?.getAttribute('aria-label')).toBe('Answers for Pick the database');
    await view.unmount();
  });
});
