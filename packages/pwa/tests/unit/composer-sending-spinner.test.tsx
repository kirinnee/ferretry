import { describe, expect, test } from 'bun:test';
import { Composer } from '../../src/components/composer.tsx';
import { LiveMarkdownEditor } from '../../src/components/live-markdown-editor.tsx';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { DaemonDraftStore, type DraftStorage } from '../../src/lib/drafts.ts';
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

describe('Composer Send while sending', () => {
  test('swaps the arrow for the one spinner mark while the message leaves, and back once it has', async () => {
    let finish: () => void = () => undefined;
    const sent = new Promise<void>(resolve => {
      finish = resolve;
    });
    const view = render(
      <Composer
        api={{ send: async () => sent as never }}
        connectionLive
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        sessionId="s"
      />,
    );
    const send = () => view.root.findByProps({ 'data-composer-send': '' });
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);

    expect(send().props['data-sending']).toBeUndefined();
    expect(view.root.findAllByProps({ 'data-spinner': '' })).toHaveLength(0);

    run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });

    expect(send().props['data-sending']).toBe('');
    expect(send().props['aria-label']).toBe('Sending…');
    const marks = send().findAllByProps({ 'data-spinner': '' });
    expect(marks).toHaveLength(1);
    expect(marks[0]?.props.className).toBe('fy-spinner fy-spinner--on-accent');

    await runAsync(async () => finish());
    expect(send().props['data-sending']).toBeUndefined();
    expect(view.root.findAllByProps({ 'data-spinner': '' })).toHaveLength(0);
    run(() => view.unmount());
  });
});
