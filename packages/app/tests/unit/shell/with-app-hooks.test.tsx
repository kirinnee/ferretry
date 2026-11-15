import { afterEach, describe, expect, test } from 'bun:test';
import { useAppHook } from '../../../src/shell/app-hooks.ts';
import { WithAppHooks } from '../../../src/testing/app-hooks.tsx';
import { mount } from '../../support/dom.ts';

/** The test shell that gives hooks: a view reads what it was given, and `undefined` for a name nobody provides. */
function Reads() {
  const given = useAppHook('d1', 'offerer.greeting') as { readonly words?: string } | undefined;
  const absent = useAppHook('d1', 'offerer.absent');
  return (
    <p>
      {given?.words ?? 'none'}/{absent === undefined ? 'undefined' : 'value'}
    </p>
  );
}

let view: Awaited<ReturnType<typeof mount>> | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('WithAppHooks', () => {
  test('gives the hooks it holds, and undefined for a name nobody provides', async () => {
    view = await mount(
      <WithAppHooks provided={{ 'offerer.greeting': { words: 'hello' } }}>
        <Reads />
      </WithAppHooks>,
    );
    expect(view.container.textContent).toBe('hello/undefined');
  });
  test('gives one daemon its own value of a hook over what it holds for every daemon', async () => {
    view = await mount(
      <WithAppHooks
        provided={{ 'offerer.greeting': { words: 'hello' } }}
        onDaemon={{
          d1: { 'offerer.greeting': { words: 'hello d1' } },
          d2: { 'offerer.greeting': { words: 'hello d2' } },
        }}
      >
        <Reads />
      </WithAppHooks>,
    );
    expect(view.container.textContent).toBe('hello d1/undefined');
  });
  test('without it there is no shell, so no hook', async () => {
    view = await mount(<Reads />);
    expect(view.container.textContent).toBe('none/undefined');
  });
});
