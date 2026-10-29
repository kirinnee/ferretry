import { afterEach, describe, expect, test } from 'bun:test';
import type { AttentionItem } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { ChatProse } from '../../../src/components/chat-prose.tsx';
import { ReferenceSurfaceProvider } from '../../../src/components/reference-surface.tsx';
import { attentionKindMeta } from '../../../src/features/attention/attention-board.tsx';
import { AttentionCard } from '../../../src/features/attention/attention-card.tsx';
import { AttentionDetail } from '../../../src/features/attention/attention-detail.tsx';
import type { ClipboardWriter } from '../../../src/features/onboarding/copy-button.tsx';
import {
  DONE_ACTION,
  historyLine,
  type InboxAction,
  NEEDS_INFO_ACTION,
  swipeMap,
  tickedSteps,
  updatedSinceAsked,
} from '../../../src/lib/attention-inbox.ts';
import { attentionItem } from '../../support/attention-inbox.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const SQUARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

const todo = (overrides: Partial<AttentionItem> = {}): AttentionItem =>
  attentionItem('A7', { subject: 'Rotate the key', ask: { kind: 'task' }, ...overrides });

const settled = async (): Promise<void> => undefined;

const chatProse =
  (write: ClipboardWriter = settled) =>
  (text: string): ReactNode => <ChatProse copyable={write} text={text} />;

const tick = (root: ParentNode, step: number): HTMLElement =>
  must(root.querySelector<HTMLElement>(`[data-attention-tick="${step}"]`), `tick ${step}`);

const done = (root: ParentNode): HTMLButtonElement =>
  must(root.querySelector<HTMLButtonElement>('[data-attention-answer="right"]'), 'the Done answer');

const checked = (root: ParentNode, step: number): boolean => (tick(root, step) as HTMLInputElement).checked;

const deferred = () => {
  let resolve: () => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<void>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe('attention card Markdown and hypermedia', () => {
  test('draws the body and each step as full Markdown, with a hypermedia block through the chat renderer', async () => {
    const item = todo({
      body: '## Why\n\n- the key leaks\n- it is **old**\n',
      steps: [
        'Run `fy secret set KEY`',
        `Look at this:\n\n\`\`\`fy-render\ntype: svg\nalt: A square\n---\n${SQUARE_SVG}\n\`\`\``,
      ],
    });
    view = await mount(<AttentionDetail layout="panel" item={item} renderProse={chatProse()} />);
    const body = must(view.container.querySelector('[data-attention-body]'), 'body');
    expect(body.querySelector('h2')?.textContent).toBe('Why');
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.querySelector('strong')?.textContent).toBe('old');
    expect(view.container.querySelector('[data-fy-render-type="svg"]')).not.toBeNull();
  });

  test('links a reference the surface proved and leaves an unproven one as prose', async () => {
    const item = todo({ body: 'See !A3 and !A9.' });
    view = await mount(
      <ReferenceSurfaceProvider
        surface={{ attentionReferenceResolver: id => id === 'A3', onAttentionOpen: () => undefined }}
      >
        <AttentionDetail layout="panel" item={item} renderProse={chatProse()} />
      </ReferenceSurfaceProvider>,
    );
    const links = [...view.container.querySelectorAll('[data-fy-reference]')];
    expect(links.map(link => link.textContent)).toEqual(['!A3']);
    expect(view.container.querySelector('[data-attention-body]')?.textContent).toContain('!A9');
  });

  test('puts a Copy button on every code span and fence in a step, and copies exactly that text', async () => {
    const written: string[] = [];
    const item = todo({ steps: ['Run `echo one` then:\n\n```sh\necho two\n```'] });
    view = await mount(
      <AttentionDetail
        layout="panel"
        item={item}
        renderProse={chatProse(async text => {
          written.push(text);
        })}
      />,
    );
    const buttons = [
      ...view.container.querySelectorAll<HTMLButtonElement>('[data-attention-step] [data-onboarding-copy]'),
    ];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) await interact(() => button.click());
    expect(written).toEqual(['echo one', 'echo two']);
  });

  test('previews a long body behind Show more, and says how to get the rest', async () => {
    const item = todo({ body: Array.from({ length: 40 }, (_, line) => `line ${line}`).join('\n\n') });
    view = await mount(<AttentionDetail layout="panel" item={item} renderProse={chatProse()} />);
    const body = must(view.container.querySelector('[data-attention-body]'), 'body');
    const toggle = must(body.querySelector<HTMLButtonElement>('[data-attention-body-toggle]'), 'toggle');
    expect(body.hasAttribute('data-folded')).toBe(true);
    expect(toggle.textContent).toBe('Show more');
    await interact(() => toggle.click());
    expect(body.hasAttribute('data-folded')).toBe(false);
    expect(toggle.textContent).toBe('Show less');
  });

  test('does not fold a short body', async () => {
    view = await mount(<AttentionDetail layout="panel" item={todo({ body: 'short' })} renderProse={chatProse()} />);
    expect(view.container.querySelector('[data-attention-body-toggle]')).toBeNull();
  });
});

describe('attention checklist', () => {
  const steps = ['one', 'two', 'three'];

  test('a tick shows at once and sends the progress action for that 0-based step', async () => {
    const calls: Array<[number, boolean]> = [];
    const pending = deferred();
    view = await mount(
      <AttentionDetail
        layout="panel"
        item={todo({ steps })}
        onProgress={(step, done) => {
          calls.push([step, done]);
          return pending.promise;
        }}
      />,
    );
    await interact(() => tick(view?.container as HTMLElement, 1).click());
    expect(calls).toEqual([[1, true]]);
    expect(checked(view.container, 1)).toBe(true);
    expect(view.container.querySelector('[data-attention-steps-count]')?.textContent).toBe('1 of 3 done');
    await interact(() => pending.resolve());
  });

  test('unticks a step the machine already has ticked', async () => {
    const calls: Array<[number, boolean]> = [];
    view = await mount(
      <AttentionDetail
        layout="panel"
        item={todo({ steps, stepsDone: [0, 2] })}
        onProgress={async (step, done) => {
          calls.push([step, done]);
        }}
      />,
    );
    expect(checked(view.container, 0)).toBe(true);
    await interact(() => tick(view?.container as HTMLElement, 0).click());
    expect(calls).toEqual([[0, false]]);
  });

  test('rolls a refused tick back and says why on the step', async () => {
    view = await mount(
      <AttentionDetail
        layout="panel"
        item={todo({ steps })}
        onProgress={async () => {
          throw new Error('the machine is read-only');
        }}
      />,
    );
    await interact(() => tick(view?.container as HTMLElement, 2).click());
    expect(checked(view.container, 2)).toBe(false);
    expect(view.container.querySelector('[data-attention-step="2"] [role="alert"]')?.textContent).toBe(
      'Step 3 was not saved: the machine is read-only',
    );
  });

  test('is read-only without a progress handler', async () => {
    view = await mount(<AttentionDetail layout="panel" item={todo({ steps })} />);
    expect(tick(view.container, 0).hasAttribute('disabled')).toBe(true);
  });

  test('Done is the primary answer, on the right, whether or not every step is ticked', async () => {
    view = await mount(<AttentionCard item={todo({ steps, stepsDone: [0, 1] })} onAct={() => {}} />);
    expect(done(view.container).getAttribute('data-variant')).toBe('primary');
    await view.render(<AttentionCard item={todo({ steps, stepsDone: [0, 1, 2] })} onAct={() => {}} />);
    expect(done(view.container).getAttribute('data-variant')).toBe('primary');
  });
});

describe('a to-do item', () => {
  test('offers Need more info left and Done right, and keeps the reply box shut', async () => {
    const acts: InboxAction[] = [];
    view = await mount(<AttentionCard item={todo()} onAct={action => acts.push(action)} />);
    expect(view.container.querySelector('textarea')).toBeNull();
    expect(view.container.querySelector('[data-attention-option]')?.getAttribute('data-attention-answer')).toBe('left');
    expect(
      [...view.container.querySelectorAll('[data-attention-answer]')].map(node => node.textContent?.trim()),
    ).toEqual(['Need more info', 'Done']);
    await interact(() => done(must(view?.container, 'view')).click());
    expect(acts).toEqual([DONE_ACTION]);
  });

  test('Need more info sends the bare action; the host adds the composer text', async () => {
    const acts: InboxAction[] = [];
    view = await mount(<AttentionCard item={todo()} onAct={action => acts.push(action)} />);
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-attention-answer="left"]'), 'ask').click(),
    );
    expect(acts).toEqual([NEEDS_INFO_ACTION]);
    expect(view.container.querySelector('textarea')).toBeNull();
  });

  test('a waiting item says who it waits on and offers no Done', async () => {
    view = await mount(
      <AttentionCard
        item={todo({ waitingOn: 'ferret', askedAt: '2026-07-31T10:42:00.000Z' })}
        onAct={() => {}}
        origin={{ ferret: 'ottilie', machine: 'workshop', href: '/x', onNavigate: () => {} }}
      />,
    );
    expect(view.container.querySelector('[data-attention-waiting]')?.textContent).toContain('With ottilie');
    expect(view.container.querySelector('[data-attention-answer]')).toBeNull();
  });

  test('an item the ferret was asked to discuss says who it is with, and stays answerable', async () => {
    const item = todo({
      waitingOn: 'ferret',
      askedAt: '2026-07-31T10:42:00.000Z',
      waitingFor: 'discussion',
      history: [{ at: '2026-07-31T10:42:00.000Z', kind: 'discuss' }],
    });
    view = await mount(
      <AttentionCard
        item={item}
        onAct={() => {}}
        origin={{ ferret: 'ottilie', machine: 'workshop', href: '/x', onNavigate: () => {} }}
      />,
    );
    expect(view.container.querySelector('[data-attention-waiting]')?.textContent).toContain('With ottilie');
    expect(view.container.querySelector('[data-attention-answer="right"]')).not.toBeNull();
    expect(view.container.querySelector('[data-attention-discuss]')).toBeNull();
    expect(view.container.querySelector('[data-attention-history]')?.textContent).toMatch(/^You asked to discuss /u);
  });

  test('shows its history, and marks an item the ferret just updated as new', async () => {
    const item = todo({
      history: [
        { at: '2026-07-31T10:42:00.000Z', kind: 'needs-info' },
        { at: '2026-07-31T10:44:00.000Z', kind: 'updated', note: 'added the rollback step' },
      ],
    });
    view = await mount(<AttentionCard item={item} onAct={() => {}} />);
    expect(view.container.querySelector('[data-attention-history]')?.textContent).toMatch(
      /^You asked for more info .+ · updated .+$/u,
    );
    expect(view.container.querySelector('[data-attention-resurfaced]')?.textContent).toContain(
      'added the rollback step',
    );
  });
});

describe('to-do helpers', () => {
  test('swipe: Done right and Need more info left; a waiting item and a text-only ask swipe nowhere', () => {
    expect(swipeMap(todo())).toEqual({ right: DONE_ACTION, left: NEEDS_INFO_ACTION });
    expect(swipeMap(todo({ waitingOn: 'ferret', askedAt: '2026-07-31T10:42:00.000Z' }))).toEqual({});
    expect(swipeMap(attentionItem('A1', { ask: { kind: 'open-question' } }))).toEqual({});
    expect(
      swipeMap(todo({ waitingOn: 'ferret', askedAt: '2026-07-31T10:42:00.000Z', waitingFor: 'discussion' })),
    ).toEqual({ right: DONE_ACTION, left: NEEDS_INFO_ACTION });
  });

  test('history reads in the given time zone', () => {
    const history = [
      { at: '2026-07-31T10:42:00.000Z', kind: 'needs-info' as const },
      { at: '2026-07-31T10:44:00.000Z', kind: 'updated' as const },
    ];
    const line = historyLine(history, 'UTC') ?? '';
    expect(line).toContain('You asked for more info');
    expect(line).toContain('10:42');
    expect(line).toContain('updated');
    expect(line).toContain('10:44');
    expect(historyLine(undefined)).toBeNull();
  });

  test('an item reads as updated only while it is not waiting and its last entry is an update', () => {
    const updated = { at: '2026-07-31T10:44:00.000Z', kind: 'updated' as const, note: 'n' };
    expect(updatedSinceAsked({ history: [updated], waitingOn: undefined })).toEqual({ at: updated.at, note: 'n' });
    expect(updatedSinceAsked({ history: [updated], waitingOn: 'ferret' })).toBeNull();
  });

  test('ticked steps layer the pending ticks over the stored ones', () => {
    expect([
      ...tickedSteps(
        { steps: ['a', 'b'], stepsDone: [0] },
        new Map([
          [1, true],
          [0, false],
        ]),
      ),
    ]).toEqual([1]);
  });
});

describe('a task item is named as one', () => {
  test('its kind reads To do, never a malformed ask', () => {
    expect(attentionKindMeta({ source: 'agent-raised', ask: { kind: 'task' } }).label).toBe('To do');
  });
});

describe('a pinned to-do keeps its header and actions in view', () => {
  test('only the middle scrolls: the header and the action row sit outside it', async () => {
    const item = todo({ body: 'Long body', steps: ['one', 'two'] });
    view = await mount(<AttentionCard item={item} onAct={() => {}} pinned renderProse={chatProse()} />);
    const scroll = must(view.container.querySelector('[data-attention-scroll]'), 'scroll region');
    expect(scroll.querySelector('header')).toBeNull();
    expect(scroll.contains(done(view.container))).toBe(false);
    expect(view.container.querySelector('header')?.textContent).toContain('Task');
  });
});
