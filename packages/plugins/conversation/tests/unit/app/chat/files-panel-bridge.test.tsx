import { describe, expect, test } from 'bun:test';
import { FerretWorkspaceActionsProvider } from '@ferretry/app';
import { ensureDom, render, run } from '@ferretry/app/testing';
import { FilesPanelBridge } from '../../../../app/chat/files-panel-bridge.tsx';

ensureDom();

/**
 * THE ONE THING A REFERENCE CLICK MAY ASK THE WORKSPACE: show the `files` panel of THIS ferret. A workspace that shows
 * another ferret is never moved, and outside any workspace there is nothing to ask.
 */
const inWorkspace = (ferret: string, shown: string[], target: { current: (() => void) | undefined }) =>
  render(
    <FerretWorkspaceActionsProvider
      canControl
      daemon="alpha"
      ferret={ferret}
      showPanel={panel => shown.push(`${ferret}:${panel}`)}
    >
      <FilesPanelBridge ferretId="shared" target={target} />
    </FerretWorkspaceActionsProvider>,
  );

describe('FilesPanelBridge', () => {
  test('hands over a way to show Files when the workspace is this ferret’s, and takes it back on unmount', () => {
    const shown: string[] = [];
    const target = { current: undefined as (() => void) | undefined };
    const tree = inWorkspace('shared', shown, target);

    target.current?.();
    run(() => tree.unmount());

    expect(shown).toEqual(['shared:files']);
    expect(target.current).toBeUndefined();
  });

  test('hands over nothing when the workspace shows another ferret', () => {
    const shown: string[] = [];
    const target = { current: undefined as (() => void) | undefined };
    const tree = inWorkspace('another', shown, target);

    expect(target.current).toBeUndefined();
    run(() => tree.unmount());
    expect(shown).toEqual([]);
  });

  test('hands over nothing outside a workspace', () => {
    const target = { current: undefined as (() => void) | undefined };
    const tree = render(<FilesPanelBridge ferretId="shared" target={target} />);

    expect(target.current).toBeUndefined();
    run(() => tree.unmount());
  });
});
