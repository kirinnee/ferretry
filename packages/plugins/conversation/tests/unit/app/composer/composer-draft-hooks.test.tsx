import { afterEach, describe, expect, test } from 'bun:test';
import { Composer } from '../../../../app/composer/composer.tsx';
import { daemonConnection } from '../../../../app/composer/seam.ts';
import { DaemonDraftStore, type DraftStorage } from '../../../../app/composer/drafts.ts';
import { ensureDom } from '@ferretry/app/testing';
ensureDom();
import { render as mountTree, run } from '@ferretry/app/testing';

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const daemon = daemonConnection('hooks');
const mounted: ReturnType<typeof mountTree>[] = [];
afterEach(() => {
  for (const view of mounted.splice(0)) run(() => view.unmount());
});

const store = new DaemonDraftStore(new MemoryStorage());
const composer = (props: { onDraftChange?: (text: string) => void; clearSignal?: number }) => (
  <Composer
    api={{ send: async () => ({}) as never }}
    daemon={daemon}
    draftStore={store}
    enterKeyPreference="send"
    phoneEnterKeyPreference="send"
    ferretId="s"
    {...props}
  />
);

const field = (view: ReturnType<typeof mountTree>) =>
  view.root.find(
    node => node.type === 'textarea' || (node.props?.onChange !== undefined && node.props?.value !== undefined),
  );

describe('Composer draft hooks', () => {
  test('tells the host the draft as it changes, starting with the empty draft', () => {
    const told: string[] = [];
    const view = mountTree(composer({ onDraftChange: text => told.push(text) }));
    mounted.push(view);
    expect(told).toEqual(['']);
    run(() => field(view).props.onChange({ currentTarget: { value: 'hello', selectionStart: 5, selectionEnd: 5 } }));
    expect(told.at(-1)).toBe('hello');
  });

  test('empties the draft when the clear signal changes, and only then', () => {
    const view = mountTree(composer({ clearSignal: 0 }));
    mounted.push(view);
    run(() => field(view).props.onChange({ currentTarget: { value: 'keep me', selectionStart: 7, selectionEnd: 7 } }));
    run(() => view.update(composer({ clearSignal: 0 })));
    expect(field(view).props.value).toBe('keep me');
    run(() => view.update(composer({ clearSignal: 1 })));
    expect(field(view).props.value).toBe('');
  });
});
