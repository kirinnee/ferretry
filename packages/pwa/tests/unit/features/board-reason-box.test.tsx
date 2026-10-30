import { afterEach, describe, expect, it } from 'bun:test';
import { MAX_BOARD_REASON_LENGTH } from '@ferretry/protocol';
import { BoardReasonBox } from '../../../src/features/board/board-reason-box.tsx';
import { interact, type Mounted, mount, must, pressKey } from '../../support/dom.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const type = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const box = async (props: Partial<Parameters<typeof BoardReasonBox>[0]> = {}) => {
  const log: string[] = [];
  view = await mount(
    <BoardReasonBox
      busy={false}
      error={null}
      heading="Move Card back to Implement"
      onCancel={() => void log.push('cancel')}
      onSubmit={reason => void log.push(`submit:${reason}`)}
      {...props}
    />,
  );
  const root = view.container;
  const input = must(root.querySelector<HTMLInputElement>('input[aria-label="Reason"]'), 'the reason input');
  const submit = must(root.querySelector<HTMLButtonElement>('button[type="submit"]'), 'the submit button');
  return { root, input, submit, log };
};

describe('BoardReasonBox', () => {
  it('is a modal dialog named by its heading, with the input focused and limited in length', async () => {
    const { root, input } = await box();
    const dialog = must(root.querySelector('[role="dialog"]'), 'the dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(root.querySelector('.fy-board-reason__heading')?.textContent).toBe('Move Card back to Implement');
    expect(document.activeElement).toBe(input);
    expect(input.maxLength).toBe(MAX_BOARD_REASON_LENGTH);
    expect(input.required).toBe(true);
  });

  it('will not send an empty or blank reason', async () => {
    const { root, input, submit, log } = await box();
    expect(submit.disabled).toBe(true);
    await interact(() => type(input, '   '));
    expect(submit.disabled).toBe(true);
    await interact(() =>
      must(root.querySelector('form'), 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(log).toEqual([]);
  });

  it('sends the reason trimmed', async () => {
    const { root, input, submit, log } = await box();
    await interact(() => type(input, '  tests were red  '));
    expect(submit.disabled).toBe(false);
    await interact(() =>
      must(root.querySelector('form'), 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(log).toEqual(['submit:tests were red']);
  });

  it('does not send twice while a move is in flight, and says so on the button', async () => {
    const { root, input, submit, log } = await box({ busy: true });
    await interact(() => type(input, 'because'));
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe('Moving…');
    await interact(() =>
      must(root.querySelector('form'), 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(log).toEqual([]);
  });

  it('cancels from the button and on Escape, and ignores other keys', async () => {
    const { root, input, log } = await box();
    await interact(() => pressKey(input, 'a'));
    expect(log).toEqual([]);
    await interact(() => pressKey(input, 'Escape'));
    await interact(() => must(root.querySelector<HTMLButtonElement>('button[type="button"]'), 'Cancel').click());
    expect(log).toEqual(['cancel', 'cancel']);
  });

  it('shows a refusal in place and ties it to the input', async () => {
    const { root, input } = await box({ error: 'The daemon said no.' });
    const alert = must(root.querySelector('[role="alert"]'), 'the refusal');
    expect(alert.textContent).toBe('The daemon said no.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('shows no refusal when there is none', async () => {
    const { root, input } = await box();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(input.getAttribute('aria-invalid')).toBe('false');
    expect(input.hasAttribute('aria-describedby')).toBe(false);
  });
});
