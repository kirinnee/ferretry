import { afterEach, describe, expect, it } from 'bun:test';
import { Floating, FloatingHost, useDismissSurface } from '../../../src/ui/floating.tsx';
import { interact, type Mounted, mount, must } from '../../support/dom.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

function Dialog() {
  const dismiss = useDismissSurface();
  return (
    <Floating>
      <div data-dialog="">
        <button data-dismiss="" onClick={dismiss} type="button">
          Dismiss
        </button>
      </div>
    </Floating>
  );
}

describe('Floating', () => {
  it('draws in place when no host provides a surface, so a panel behaves as it did on its own', async () => {
    mounted = await mount(<Dialog />);

    expect(mounted.container.querySelector('[data-dialog]')).not.toBeNull();
  });

  it('draws in the host’s element instead of in the panel, so a menu or sheet around it cannot box it in', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    let dismissed = 0;
    mounted = await mount(
      <FloatingHost
        dismiss={() => {
          dismissed += 1;
        }}
        element={host}
      >
        <section data-menu="">
          <Dialog />
        </section>
      </FloatingHost>,
    );

    expect(mounted.container.querySelector('[data-dialog]')).toBeNull();
    expect(host.querySelector('[data-dialog]')).not.toBeNull();

    await interact(() => must(host.querySelector<HTMLElement>('[data-dismiss]'), 'the dismiss button').click());
    expect(dismissed).toBe(1);
    host.remove();
  });

  it('dismisses nothing when the panel is not in a menu', async () => {
    mounted = await mount(<Dialog />);

    await interact(() => must(mounted?.container.querySelector<HTMLElement>('[data-dismiss]'), 'dismiss').click());
    expect(mounted.container.querySelector('[data-dialog]')).not.toBeNull();
  });
});
