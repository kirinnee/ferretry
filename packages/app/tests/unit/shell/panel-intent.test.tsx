import { describe, expect, test } from 'bun:test';
import type { PanelIntent } from '@ferretry/kernel/manifest';
import { ensureDom, render, run } from '../../../src/testing/index.ts';
import { usePanelIntent } from '../../../src/shell/panel-intent.ts';

ensureDom();

function Panel({ intent, ran }: { readonly intent: PanelIntent | undefined; readonly ran: string[] }) {
  usePanelIntent(intent, 'new-terminal', () => ran.push('new-terminal'));
  return null;
}

describe('a panel answering its host’s request', () => {
  test('acts once on a request for its action, and not again on a re-render with the same one', () => {
    const ran: string[] = [];
    const page = render(<Panel intent={undefined} ran={ran} />);
    run(() => page.update(<Panel intent={{ id: 1, action: 'new-terminal' }} ran={ran} />));
    run(() => page.update(<Panel intent={{ id: 1, action: 'new-terminal' }} ran={ran} />));
    expect(ran).toEqual(['new-terminal']);
    run(() => page.update(<Panel intent={{ id: 2, action: 'new-terminal' }} ran={ran} />));
    expect(ran).toEqual(['new-terminal', 'new-terminal']);
    run(() => page.unmount());
  });

  test('ignores an action that is not its own', () => {
    const ran: string[] = [];
    const page = render(<Panel intent={undefined} ran={ran} />);
    run(() => page.update(<Panel intent={{ id: 1, action: 'new-page' }} ran={ran} />));
    expect(ran).toEqual([]);
    run(() => page.unmount());
  });

  test('never acts on the request it mounted with', () => {
    const ran: string[] = [];
    const page = render(<Panel intent={{ id: 7, action: 'new-terminal' }} ran={ran} />);
    expect(ran).toEqual([]);
    run(() => page.unmount());
  });
});
