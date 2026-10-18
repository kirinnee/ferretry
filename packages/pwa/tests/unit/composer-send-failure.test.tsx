import { describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { LiveMarkdownEditor } from '../../src/components/live-markdown-editor.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
import { type CarrierDelivery, CarrierUnavailableError } from '../../src/lib/relay-carrier.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const daemon = daemonConnection({ daemonId: 'calm', baseUrl: 'https://calm.example.test', deviceId: 'device' });
const WALK =
  'could not reach fyd (No configured connection worked: direct was not reachable (1006); hosted relay was not reachable (1006))';

/** What the typed client throws: its transport error, wrapping the router's outage as its cause. */
const outage = (delivery: CarrierDelivery): Error =>
  new Error(WALK, {
    cause: new CarrierUnavailableError(
      WALK,
      {
        failures: [{ label: 'Direct', detail: 'direct was not reachable (1006)' }],
        daemonAbsent: false,
        relaysNeverOpened: true,
      },
      delivery,
    ),
  });

const failSend = async (thrown: unknown) => {
  const view = render(
    <Composer
      api={{
        send: async () => {
          throw thrown;
        },
      }}
      daemon={daemon}
      draftStore={new DaemonDraftStore(new MemoryStorage())}
      sessionId="s"
    />,
  );
  const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
  run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
  await runAsync(async () => {
    view.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  const lines = view.root.findAll(node => node.type === 'p' && node.props.className === 'fy-composer-error');
  const shown = { error: lines.length === 0 ? null : String(lines[0]?.props.children), draft: field().props.value };
  run(() => view.unmount());
  return shown;
};

describe('Composer send failures', () => {
  test('says "send it again" only when nothing of the send provably left, and keeps the draft', async () => {
    expect(await failSend(outage('unsent'))).toEqual({
      error: 'Not sent — the connection dropped. Your message is still here; send it again.',
      draft: 'hello',
    });
  });

  test('never invites a resend when the send may already be with the daemon', async () => {
    const shown = await failSend(outage('unknown'));
    expect(shown.error).toBe(
      'Connection dropped while sending — checking whether it arrived. Don’t send it again; it will show in the transcript.',
    );
    expect(shown.error).not.toContain('1006');
  });

  test('says what the daemon said for anything that is not an outage', async () => {
    expect((await failSend(new Error('session is stopped'))).error).toBe('session is stopped');
    expect((await failSend('opaque')).error).toBe('Message could not be sent');
  });
});
