import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'react';
import { AttachmentUnlockPrompt } from '../../src/components/attachment-unlock-prompt.tsx';
import { attachmentUnlockFailure } from '../../src/lib/attachment-unlock.ts';
import { render } from '../support/react.ts';
import { interact, mount } from '../support/dom.ts';

const nativeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

const typePassword = async (input: HTMLInputElement, password: string): Promise<void> => {
  await interact(() => {
    nativeValueSetter?.call(input, password);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const prompt = (overrides: Partial<ComponentProps<typeof AttachmentUnlockPrompt>> = {}) => (
  <AttachmentUnlockPrompt filename="statement.pdf" onCancel={() => {}} onUnlock={async () => {}} open {...overrides} />
);

describe('AttachmentUnlockPrompt', () => {
  test('renders through the shared React renderer when closed', () => {
    const tree = render(
      <AttachmentUnlockPrompt filename="statement.pdf" onCancel={() => {}} onUnlock={async () => {}} open={false} />,
    );
    expect(tree.toJSON()).toBeNull();
  });

  test('renders the password contract and never enables a blank submission', async () => {
    const sheet = await mount(prompt());
    const input = sheet.container.querySelector('input[type="password"]') as HTMLInputElement;
    const submit = sheet.container.querySelector('button[type="submit"]') as HTMLButtonElement;

    expect(sheet.container.textContent).toContain('Unlock encrypted PDF');
    expect(sheet.container.textContent).toContain('statement.pdf needs a password.');
    expect(sheet.container.textContent).toContain('never written to disk');
    expect(input.autocomplete).toBe('off');
    expect(submit.disabled).toBe(true);

    await sheet.unmount();
  });

  test('submits an entered password and clears it after success', async () => {
    const passwords: string[] = [];
    const sheet = await mount(
      prompt({
        onUnlock: async password => {
          passwords.push(password);
        },
      }),
    );
    const input = sheet.container.querySelector('input') as HTMLInputElement;
    const form = sheet.container.querySelector('form') as HTMLFormElement;

    await typePassword(input, 'open-sesame');
    await interact(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(passwords).toEqual(['open-sesame']);
    expect(input.value).toBe('');
    await sheet.unmount();
  });

  test('makes only an incorrect password retryable and redacts opaque daemon errors', async () => {
    const sheet = await mount(prompt({ onUnlock: async () => Promise.reject({ code: 'wrong_password' }) }));
    const input = sheet.container.querySelector('input') as HTMLInputElement;
    const form = sheet.container.querySelector('form') as HTMLFormElement;

    await typePassword(input, 'wrong');
    await interact(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(sheet.container.querySelector('[role="alert"]')?.textContent).toContain('try again');
    expect((sheet.container.querySelector('button[type="submit"]') as HTMLButtonElement).textContent).toContain(
      'Try again',
    );
    expect(attachmentUnlockFailure(new Error('/home/kirin/secret.pdf')).message.includes('/home/kirin')).toBe(false);
    expect(attachmentUnlockFailure({ code: 'decryption_unavailable' })).toMatchObject({ retryable: false });
    await sheet.unmount();
  });

  test('does not allow cancellation while the daemon is decrypting', async () => {
    let resolve!: () => void;
    const pending = new Promise<void>(done => {
      resolve = done;
    });
    let cancellations = 0;
    const sheet = await mount(prompt({ onCancel: () => (cancellations += 1), onUnlock: async () => pending }));
    const input = sheet.container.querySelector('input') as HTMLInputElement;
    const form = sheet.container.querySelector('form') as HTMLFormElement;

    await typePassword(input, 'wait');
    await interact(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await interact(() => (sheet.container.querySelector('button[type="button"].kt-btn') as HTMLButtonElement).click());
    expect(cancellations).toBe(0);
    expect(sheet.container.textContent).toContain('Decrypting…');

    await interact(async () => resolve());
    await sheet.unmount();
  });
});
