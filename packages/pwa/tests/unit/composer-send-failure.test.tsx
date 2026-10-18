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

const composer = (thrown: unknown, store: DaemonDraftStore, connectionLive: boolean) => (
  <Composer
    api={{
      send: async () => {
        throw thrown;
      },
    }}
    connectionLive={connectionLive}
    daemon={daemon}
    draftStore={store}
    sessionId="s"
  />
);

const failSend = async (thrown: unknown) => {
  const store = new DaemonDraftStore(new MemoryStorage());
  const view = render(composer(thrown, store, false));
  const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
  run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
  await runAsync(async () => {
    view.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  const errorText = (): string | null => {
    const lines = view.root.findAll(node => node.type === 'p' && node.props.className === 'fy-composer-error');
    return lines.length === 0 ? null : String(lines[0]?.props.children);
  };
  const shown = { error: errorText(), draft: field().props.value };
  // The machine answers again.
  run(() => view.update(composer(thrown, store, true)));
  const afterRecovery = errorText();
  run(() => view.unmount());
  return { ...shown, afterRecovery };
};

describe('Composer send failures', () => {
  test('says "send it again" only when nothing of the send provably left, and keeps the draft until the machine answers', async () => {
    expect(await failSend(outage('unsent'))).toEqual({
      error: 'Not sent — the connection dropped. Your message is still here; send it again.',
      draft: 'hello',
      afterRecovery: null,
    });
  });

  test('never invites a resend when the send may already be with the daemon, not even once it reconnects', async () => {
    const shown = await failSend(outage('unknown'));
    expect(shown.error).toBe(
      'Connection dropped while sending — checking whether it arrived. Don’t send it again; it will show in the transcript.',
    );
    expect(shown.error).not.toContain('1006');
    // Reconnecting takes under a second, and a line that vanished then left the draft one press from a
    // duplicate (E2E: delivered once, draft still in the box, Send enabled, nothing said). It stays, and
    // points at the transcript, whose send row settles it under the original id.
    expect(shown.draft).toBe('hello');
    expect(shown.afterRecovery).toBe(
      'Back online — check the transcript before sending again; this message may already be there.',
    );
  });

  test('says what the daemon said for anything that is not an outage, and keeps saying it', async () => {
    const refused = await failSend(new Error('session is stopped'));
    expect(refused.error).toBe('session is stopped');
    // Not an outage, so recovery does not make it untrue.
    expect(refused.afterRecovery).toBe('session is stopped');
    expect((await failSend('opaque')).error).toBe('Message could not be sent');
  });
});
