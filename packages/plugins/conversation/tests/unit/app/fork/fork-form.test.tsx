import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';
import type { ForkRequest, ForkResult } from '../../../../contract/index.ts';
import type { ForkChoice } from '../../../../app/fork/fork-api.ts';
import { ForkForm } from '../../../../app/fork/fork-form.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const CHOICES: readonly ForkChoice[] = [
  { point: '10.0', selectionBinding: 's2.one', text: 'first question', timestamp: '2026-02-01T09:00:00.000Z' },
  { point: '20.0', selectionBinding: 's2.two', text: 'second question' },
  { point: '30.0', selectionBinding: 's2.three', text: 'third question' },
];
const RESULT: ForkResult = { ferret: 'f2', attachments: 0 };

const open = async (
  props: { choices?: readonly ForkChoice[]; initial?: string; older?: boolean } = {},
  submit: (request: ForkRequest) => Promise<ForkResult> = async () => RESULT,
) => {
  const sent: ForkRequest[] = [];
  const forked: ForkResult[] = [];
  const closes: number[] = [];
  mounted = await mount(
    <ForkForm
      choices={props.choices ?? CHOICES}
      host={{ close: () => closes.push(1), forked: result => forked.push(result) }}
      initial={props.initial}
      older={props.older ?? false}
      submit={async request => {
        sent.push(request);
        return await submit(request);
      }}
    />,
  );
  return { root: mounted.container, sent, forked, closes };
};

const radio = (root: HTMLElement, name: string, value: string): HTMLInputElement =>
  must(
    [...root.querySelectorAll<HTMLInputElement>(`input[type="radio"][name$="${name}"]`)].find(
      input => input.value === value,
    ),
    `the ${value} choice`,
  );
const submitButton = (root: HTMLElement): HTMLButtonElement =>
  must(root.querySelector('[data-action-submit]'), 'submit button') as HTMLButtonElement;
const press = async (root: HTMLElement): Promise<void> => {
  await interact(() => submitButton(root).click());
  await interact(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
};

describe('the Fork form', () => {
  it('lists what was said newest first and opens on the latest', async () => {
    const { root } = await open();
    const texts = [...root.querySelectorAll('.fy-fork-pick__text')].map(node => node.textContent);
    expect(texts).toEqual(['third question', 'second question', 'first question']);
    expect(radio(root, '-through', '30.0').checked).toBe(true);
  });

  it('opens on the message it was asked to, and sends that message’s own point and binding', async () => {
    const { root, sent, forked } = await open({ initial: '20.0' });
    expect(radio(root, '-through', '20.0').checked).toBe(true);
    await press(root);
    expect(sent).toEqual([{ point: '20.0', selectionBinding: 's2.two', worktree: 'new' }]);
    expect(forked).toEqual([RESULT]);
  });

  it('sends the name trimmed, and the folder choice', async () => {
    const { root, sent } = await open();
    const name = must(root.querySelector('input.kt-input'), 'name field') as HTMLInputElement;
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(name, '  try-the-other-way ');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await interact(() => radio(root, '-where', 'same').click());
    await press(root);
    expect(sent).toEqual([
      { point: '30.0', selectionBinding: 's2.three', name: 'try-the-other-way', worktree: 'same' },
    ]);
  });

  it('refuses a name that is not a callsign before anything is sent, in words, and sends nothing', async () => {
    const { root, sent } = await open();
    const name = must(root.querySelector('input.kt-input'), 'name field') as HTMLInputElement;
    await interact(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(name, 'Try it the other way');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(root);
    expect(sent).toEqual([]);
    expect(root.querySelector('.fy-action-form__error')?.textContent).toBe(
      'A name starts with a letter and has only letters, digits and hyphens, like fix-login.',
    );
  });

  it('says plainly what a new worktree does not carry, and what the same folder shares', async () => {
    const { root } = await open();
    const note = (): string | null => root.querySelector('[data-fork-where-note]')?.textContent ?? null;
    expect(note()).toContain('Changes you have not committed are not copied');
    await interact(() => radio(root, '-where', 'same').click());
    expect(note()).toContain('Both ferrets work in this folder');
  });

  it('shows the daemon’s own sentence when the fork is refused, keeps the form open and forks nothing', async () => {
    const sentence =
      'the conversation was written by Codex 0.99.0, a rollout format Ferretry has not tested, so it was not forked';
    const { root, forked, closes } = await open({}, async () => {
      throw new Error(sentence);
    });
    await press(root);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(sentence);
    expect(forked).toEqual([]);
    expect(closes).toEqual([]);
    expect(submitButton(root).disabled).toBe(false);
  });

  it('says there is nothing to fork when nothing was said yet', async () => {
    const { root } = await open({ choices: [] });
    expect(root.textContent).toContain('nothing to fork yet');
    expect(root.querySelector('[data-action-submit]')).toBeNull();
  });

  it('says older messages are not listed when the read was cut', async () => {
    const { root } = await open({ older: true });
    expect(root.textContent).toContain('Older messages are not listed here.');
  });
});
