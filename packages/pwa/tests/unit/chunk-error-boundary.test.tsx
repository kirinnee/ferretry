import { describe, expect, it } from 'bun:test';
import { ChunkErrorBoundary } from '../../src/shell/chunk-error-boundary.tsx';
import { interact, mount } from '../support/dom.ts';

const Boom = ({ explode }: { readonly explode: boolean }) => {
  if (explode) throw new TypeError("Cannot read properties of undefined (reading 'SessionChatPage')");
  return <p data-testid="pane">the pane</p>;
};

interface Caught {
  readonly errors: unknown[];
  readonly reloads: number;
  readonly reports: string[];
}

const boundary = (caught: Caught & { reloads: number }, explode: boolean) => (
  <ChunkErrorBoundary
    onChunkError={error => caught.errors.push(error)}
    onReload={() => {
      caught.reloads += 1;
    }}
    onReport={message => caught.reports.push(message)}
  >
    <Boom explode={explode} />
  </ChunkErrorBoundary>
);

const freshCaught = () => ({ errors: [] as unknown[], reloads: 0, reports: [] as string[] });

describe('ChunkErrorBoundary', () => {
  it('is exactly transparent around a healthy pane — no wrapper element at all', async () => {
    const caught = freshCaught();
    const mounted = await mount(boundary(caught, false));

    expect(mounted.container.innerHTML).toBe('<p data-testid="pane">the pane</p>');
    expect(caught.errors).toEqual([]);
    await mounted.unmount();
  });

  it('replaces a dead pane with an assertive alert instead of letting React blank the root', async () => {
    const caught = freshCaught();
    const mounted = await mount(boundary(caught, true));

    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('This page failed to load — reload to recover.');
    expect(mounted.container.querySelector('[data-testid="pane"]')).toBeNull();
    await mounted.unmount();
  });

  it('stays neutral about the cause, because it catches every render error and not only a pruned chunk', async () => {
    const caught = freshCaught();
    const mounted = await mount(boundary(caught, true));

    const text = mounted.container.textContent ?? '';
    expect(text).not.toContain('chunk');
    expect(text).not.toContain('deploy');
    await mounted.unmount();
  });

  it('reports the error rather than swallowing it, and raises it once to the caller', async () => {
    const caught = freshCaught();
    const mounted = await mount(boundary(caught, true));

    expect(caught.reports).toEqual(['ferretry: a pane failed to render']);
    expect(caught.errors).toHaveLength(1);
    expect((caught.errors[0] as Error).message).toContain('SessionChatPage');
    await mounted.unmount();
  });

  it('hands the reload to the caller so the guarded no-waiter branch is not reimplemented here', async () => {
    const caught = freshCaught();
    const mounted = await mount(boundary(caught, true));

    const button = mounted.container.querySelector('button') as HTMLElement;
    expect(button.textContent).toContain('Reload to recover');

    await interact(() => button.click());
    await interact(() => button.click());

    expect(caught.reloads).toBe(2);
    await mounted.unmount();
  });

  it('falls back to the console when no reporter is injected', async () => {
    const original = console.warn;
    const lines: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args);
    };

    try {
      const errors: unknown[] = [];
      const mounted = await mount(
        <ChunkErrorBoundary onChunkError={error => errors.push(error)} onReload={() => {}}>
          <Boom explode />
        </ChunkErrorBoundary>,
      );

      expect(lines[0]?.[0]).toBe('ferretry: a pane failed to render');
      expect(errors).toHaveLength(1);
      await mounted.unmount();
    } finally {
      console.warn = original;
    }
  });

  it('derives the failed state purely, so the re-render after the throw stays side-effect free', () => {
    expect(ChunkErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });
});
