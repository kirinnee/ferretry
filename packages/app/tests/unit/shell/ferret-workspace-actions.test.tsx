import { afterEach, describe, expect, test } from 'bun:test';
import { FerretWorkspace } from '../../../src/shell/ferret-workspace.tsx';
import { type FerretWorkspaceActions, useFerretWorkspace } from '../../../src/shell/ferret-workspace-actions.tsx';
import { ensureDom, render, run } from '../../../src/testing/index.ts';

ensureDom();

/** What a panel of the ferret page would read: the workspace around it, as it stands. */
const seen: (FerretWorkspaceActions | null)[] = [];
function Reader() {
  seen.push(useFerretWorkspace());
  return null;
}

afterEach(() => {
  seen.length = 0;
});

describe('the ferret workspace tells its panels whether this connection may control the ferret', () => {
  test('hands the flag the page gave it to every panel', () => {
    const page = render(<FerretWorkspace canControl={false} chat={<Reader />} daemon="d1" subject="f1" />);
    expect(seen.at(-1)).toMatchObject({ daemon: 'd1', ferret: 'f1', canControl: false });
    run(() => page.unmount());
  });

  test('says control may be used when the page named no restriction, and follows a change', () => {
    const page = render(<FerretWorkspace chat={<Reader />} daemon="d1" subject="f1" />);
    expect(seen.at(-1)?.canControl).toBe(true);
    run(() => page.update(<FerretWorkspace canControl={false} chat={<Reader />} daemon="d1" subject="f1" />));
    expect(seen.at(-1)?.canControl).toBe(false);
    run(() => page.unmount());
  });

  test('is null outside a workspace', () => {
    const page = render(<Reader />);
    expect(seen.at(-1)).toBeNull();
    run(() => page.unmount());
  });
});
