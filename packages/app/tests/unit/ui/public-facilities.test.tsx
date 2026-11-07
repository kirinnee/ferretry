import { expect, test } from 'bun:test';
import { Button, describeSurfaceOwnership, FY_REQUEST_ID_HEADER } from '../../../src/index.ts';
import { CopyButton, Button as UiButton } from '../../../src/ui/index.ts';

test('connect-only users of the public testing entry keep their environment without a DOM', () => {
  const entry = new URL('../../../src/testing/index.ts', import.meta.url).href;
  const checked = Bun.spawnSync([
    'bun',
    '-e',
    `
    const before = typeof globalThis.document;
    const { fakeDeviceClaims } = await import(${JSON.stringify(entry)});
    if (typeof globalThis.document !== before) throw new Error('the connect fake registered a DOM');
    if (fakeDeviceClaims().asked.length !== 0) throw new Error('the connect fake changed');
  `,
  ]);
  expect(checked.exitCode).toBe(0);
});
import { fakeDeviceClaims, interact, mount, must, render, run } from '../../../src/testing/index.ts';

test('public shell facilities keep provenance unknown until attested and expose the shared primitives', () => {
  expect(Button).toBe(UiButton);
  expect(FY_REQUEST_ID_HEADER).toBe('x-fy-request-id');
  expect(describeSurfaceOwnership({ by: 'unrecorded' })).toEqual({ text: 'Owner unrecorded', tone: 'pend' });
  expect(describeSurfaceOwnership({ by: 'local' }).text).toBe('Opened on the daemon host');
  expect(describeSurfaceOwnership({ by: 'human', deviceId: 'device-one' }).detail).toBe('device device-one');
  expect(describeSurfaceOwnership({ by: 'agent', sessionId: 'ferret-one' })).toEqual({
    text: 'Opened by an agent',
    tone: 'warn',
    detail: 'agent session ferret-one',
  });
});

test('the public test harness drives clipboard refusal without claiming a successful copy', async () => {
  const view = await mount(
    <CopyButton
      text="bun dev"
      label="Copy command"
      write={async () => {
        throw new Error('clipboard refused');
      }}
    />,
  );
  try {
    await interact(() => must(view.container.querySelector('button'), 'copy button').click());
    expect(view.container.textContent).toContain('Copy was blocked');
    expect(view.container.textContent).not.toContain('Copied');
  } finally {
    await view.unmount();
  }
});

test('the public test harness retains connect fakes and the render-tree harness', () => {
  expect(fakeDeviceClaims().asked).toEqual([]);
  const tree = render(<Button>Run</Button>);
  try {
    expect(tree.root.findByType('button').children).toEqual(['Run']);
  } finally {
    run(() => tree.unmount());
  }
});
