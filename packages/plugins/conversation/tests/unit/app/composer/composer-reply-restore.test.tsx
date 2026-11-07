/**
 * &B142 — the words an Inbox reply took back come back into THAT card's composer, once, without doubling what is
 * already there; and the composer tells its host what it sent (words, the queue's id for the message, its disposition).
 */
import { describe, expect, test } from 'bun:test';
import { Composer, type ComposerSent } from '../../../../app/composer/composer.tsx';
import { LiveMarkdownEditor } from '@ferretry/app';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { daemonFerretScope } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render, run, runAsync } from '@ferretry/app/testing';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const daemon = daemonConnection('calm');

const restoring = async (stored: string, restore: string | undefined) => {
  const store = new DaemonDraftStore(new MemoryStorage());
  if (stored !== '') store.save(daemonFerretScope(daemon, 's'), stored);
  const restored: string[] = [];
  const view = render(
    <Composer
      api={{ send: async () => ({}) as never }}
      connectionLive
      daemon={daemon}
      draftStore={store}
      onRestored={() => restored.push('taken')}
      restore={restore}
      ferretId="s"
    />,
  );
  await runAsync(async () => undefined);
  const field = view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
  const shown = String(field.props.value);
  run(() => view.unmount());
  return { shown, restored };
};

describe('Composer restore', () => {
  test('puts the words back in an empty box and says they were taken', async () => {
    expect(await restoring('', 'only after lunch')).toEqual({ shown: 'only after lunch', restored: ['taken'] });
  });

  test('puts them above what has been typed since, so nothing is lost', async () => {
    expect((await restoring('and call me', 'only after lunch')).shown).toBe('only after lunch\n\nand call me');
  });

  test('does not double words the box already holds', async () => {
    expect((await restoring('only after lunch, then call me', 'only after lunch')).shown).toBe(
      'only after lunch, then call me',
    );
  });

  test('leaves the box alone with nothing to restore', async () => {
    expect(await restoring('typed', undefined)).toEqual({ shown: 'typed', restored: [] });
    expect(await restoring('typed', '')).toEqual({ shown: 'typed', restored: [] });
  });
});

describe('Composer onSent', () => {
  const sending = async (answer: unknown) => {
    const store = new DaemonDraftStore(new MemoryStorage());
    const sent: ComposerSent[] = [];
    const view = render(
      <Composer
        api={{ send: async () => answer as never }}
        connectionLive
        daemon={daemon}
        draftStore={store}
        onSent={each => sent.push(each)}
        ferretId="s"
      />,
    );
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
    run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    run(() => view.unmount());
    return sent;
  };

  test('hands the host the words, the queue id and the disposition the machine answered', async () => {
    expect(await sending({ disposition: 'queued', sendId: 'q1' })).toEqual([
      { words: 'hello', sendId: 'q1', disposition: 'queued' },
    ]);
  });

  test('has no queue id when the machine named none', async () => {
    expect(await sending({ disposition: 'delivered' })).toEqual([
      { words: 'hello', sendId: undefined, disposition: 'delivered' },
    ]);
    expect(await sending({ disposition: 'queued', sendId: 7 })).toEqual([
      { words: 'hello', sendId: undefined, disposition: 'queued' },
    ]);
  });
});

describe('Composer onSending', () => {
  test('is told the moment a send starts, before the request has come back', async () => {
    const order: string[] = [];
    const view = render(
      <Composer
        api={{
          send: async () => {
            order.push('request');
            return { disposition: 'delivered' } as never;
          },
        }}
        connectionLive
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        onSending={() => order.push('sending')}
        onSent={() => order.push('sent')}
        ferretId="s"
      />,
    );
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
    run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    run(() => view.unmount());
    expect(order).toEqual(['sending', 'request', 'sent']);
  });
});

describe('Composer onSendFailed', () => {
  test('is told when a send that was announced did not go, and onSent is not', async () => {
    const order: string[] = [];
    const view = render(
      <Composer
        api={{
          send: async () => {
            order.push('request');
            throw new Error('offline');
          },
        }}
        connectionLive
        daemon={daemon}
        draftStore={new DaemonDraftStore(new MemoryStorage())}
        onSendFailed={() => order.push('failed')}
        onSending={() => order.push('sending')}
        onSent={() => order.push('sent')}
        ferretId="s"
      />,
    );
    const field = () => view.root.find(node => node.type === 'textarea' || node.type === LiveMarkdownEditor);
    run(() => field().props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
    await runAsync(async () => {
      view.root.findByType('form').props.onSubmit({ preventDefault() {} });
    });
    run(() => view.unmount());
    expect(order).toEqual(['sending', 'request', 'failed']);
  });
});
