import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Composer, type ComposerProps } from '../../../../app/composer/composer.tsx';
import { daemonConnection, daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { writeMdComposePref } from '@ferretry/app';
import { composerQuoteTarget } from '@ferretry/app';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

/** The two fixtures this suite took from the Board suites' support file. */
const laptop = daemonConnection('daemon/laptop');
const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(done => setTimeout(done, 0));
};

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

// A detached composer (the Not good box) is the chat's composer with the chat's state taken away.
it('publishes no quote target, offers no attach, and sends the words as typed', async () => {
  const values = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
  const messages: string[] = [];
  view = await mount(
    <Composer
      api={
        {
          send: async (_session: string, input: { readonly message: string }) => void messages.push(input.message),
        } as unknown as ComposerProps['api']
      }
      daemon={laptop}
      detached={{ sendLabel: 'Send back', attachable: false }}
      draftStore={new DaemonDraftStore(storage)}
      ferretId="child-1"
    />,
  );
  const mouse = new Event('pointerdown');
  Object.defineProperty(mouse, 'pointerType', { value: 'mouse' });
  await interact(() => window.dispatchEvent(mouse));

  expect(composerQuoteTarget(daemonFerretScope(laptop, 'child-1'))).toBeNull();
  expect(view.container.querySelector('[data-composer-attach]')).toBeNull();
  // No session readouts to hold: the box ends at the field, with no empty band under it.
  expect(view.container.querySelector('[data-composer-status]')).toBeNull();

  const field = must(view.container.querySelector<HTMLTextAreaElement>('textarea'), 'the composer field');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'not good');
  await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
  await interact(() => flush());
  await interact(() =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  await interact(() => flush());
  expect(messages).toEqual(['not good']);
});
