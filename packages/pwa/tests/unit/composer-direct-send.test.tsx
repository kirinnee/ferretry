import { afterEach, beforeEach, expect, it } from 'bun:test';
import { Composer, type ComposerProps } from '../../src/components/composer.tsx';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { writeMdComposePref } from '../../src/lib/md-compose.ts';
import { type AppStore, StoreProvider } from '../../src/lib/store.tsx';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { flush, laptop } from './board-support.ts';

beforeEach(() => writeMdComposePref('off'));
afterEach(() => writeMdComposePref('on'));

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

/** Types `words` into the composer and presses Enter. */
const typeAndSend = async (words: string): Promise<void> => {
  const field = must(view?.container.querySelector<HTMLTextAreaElement>('textarea'), 'the composer field');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, words);
  await interact(() => field.dispatchEvent(new Event('input', { bubbles: true })));
  await interact(() => flush());
  await interact(() =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
  );
  await interact(() => flush());
};

const drawn = async (directSend: boolean) => {
  const values = new Map<string, string>();
  const storage: DraftStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
  const sent: string[] = [];
  const parked: string[] = [];
  // A device outbox that parks every send: what it holds is sent AGAIN later, as a chat message.
  const outbox = {
    submit: async (entry: { readonly message: string }) => {
      parked.push(entry.message);
      return { entry: { id: 'send-1' }, outcome: { kind: 'waiting' }, stored: true };
    },
    cancel: async () => undefined,
  };
  view = await mount(
    <StoreProvider store={{ outbox } as unknown as AppStore}>
      <Composer
        api={
          {
            send: async (_session: string, input: { readonly message: string }) => void sent.push(input.message),
          } as unknown as ComposerProps['api']
        }
        daemon={laptop}
        directSend={directSend}
        // Pinned for both modalities: a test earlier in the run can leave the shared input modality on touch.
        enterKeyPreference="send"
        phoneEnterKeyPreference="send"
        draftStore={new DaemonDraftStore(storage)}
        sessionId="sess-1"
        sharedUploads={false}
      />
    </StoreProvider>,
  );
  return { sent, parked };
};

it('a direct send is the host’s own call: never parked in the device outbox, the words exactly as typed', async () => {
  const { sent, parked } = await drawn(true);
  await typeAndSend('  the badge is red  ');
  expect(sent).toEqual(['the badge is red']);
  expect(parked).toEqual([]);
});

it('an ordinary send still goes through the device outbox', async () => {
  const { sent, parked } = await drawn(false);
  await typeAndSend('hello');
  expect(parked).toEqual(['hello']);
  expect(sent).toEqual([]);
});
