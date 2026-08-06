import { describe, expect, it } from 'bun:test';
import { useFsResource, type FsResource } from '../../src/components/files-resource.ts';
import { interact, mount, must } from '../support/dom.ts';

interface ProbeProps {
  resourceKey: string | null;
  load: (signal: AbortSignal) => Promise<string>;
  onResource: (resource: FsResource<string>) => void;
}

const Probe = ({ resourceKey, load, onResource }: ProbeProps) => {
  const resource = useFsResource<string>(resourceKey, load);
  onResource(resource);
  // `data` FIRST: a retained value is what the panes show while a reread runs
  // or after it fails, so the probe has to read the same way they do.
  return <output>{resource.data ?? (resource.loading ? 'loading' : (resource.error ?? 'idle'))}</output>;
};

const text = (container: HTMLElement): string =>
  must(container.querySelector('output'), 'the probe output').textContent ?? '';

/**
 * Reads a value the probe assigns from a render callback.
 *
 * The read goes through a function boundary on purpose: inside one, TypeScript
 * uses the variable's declared type instead of the `null` its initializer
 * narrowed it to, so every assertion below is against a real resource.
 */
const latestOf = <T,>(read: () => T | null, what: string): T => must(read(), what);

describe('the Files async resource', () => {
  it('stays idle for a null key and never calls the loader', async () => {
    let calls = 0;
    const view = await mount(
      <Probe
        resourceKey={null}
        load={async () => {
          calls += 1;
          return 'never';
        }}
        onResource={() => {}}
      />,
    );
    expect(text(view.container)).toBe('idle');
    expect(calls).toBe(0);
    await view.unmount();
  });

  it('reports an error for a key whose FIRST read fails, with nothing to keep', async () => {
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={async () => {
          throw new Error('daemon refused');
        }}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('daemon refused');
    const resource = latestOf(() => latest, 'the latest resource');
    expect(resource.data).toBeNull();
    expect(resource.loading).toBe(false);
    // Nothing is on screen, so nothing on screen can be stale.
    expect(resource.stale).toBe(false);
    expect(resource.refreshing).toBe(false);
    expect(resource.revision).toBe(0);
    await view.unmount();
  });

  it('keeps the last good value visible while the SAME key is re-read, and says it is not the newest', async () => {
    let release: ((value: string) => void) | null = null;
    let reads = 0;
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={() => {
          reads += 1;
          return reads === 1
            ? Promise.resolve('the first bytes')
            : new Promise<string>(resolve => {
                release = resolve;
              });
        }}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('the first bytes');
    const loaded = latestOf(() => latest, 'the settled resource').revision;
    expect(loaded).toBe(1);

    await interact(() => latestOf(() => latest, 'the settled resource').reload());
    // Mid-reread: the value is still there, and it is honestly labelled.
    expect(text(view.container)).toBe('the first bytes');
    const during = latestOf(() => latest, 'the refreshing resource');
    expect(during.refreshing).toBe(true);
    expect(during.stale).toBe(true);
    expect(during.loading).toBe(false);
    expect(during.error).toBeNull();
    // The revision names the snapshot ON SCREEN, so it has not moved yet.
    expect(during.revision).toBe(loaded);

    await interact(async () => {
      must(release, 'the stalled reread')('the second bytes');
    });
    expect(text(view.container)).toBe('the second bytes');
    const after = latestOf(() => latest, 'the reloaded resource');
    expect(after.stale).toBe(false);
    expect(after.refreshing).toBe(false);
    expect(after.revision).toBe(loaded + 1);
    await view.unmount();
  });

  it('keeps the last good value when the re-read FAILS, and lets the reader try again', async () => {
    let reads = 0;
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={async () => {
          reads += 1;
          if (reads === 2) throw new Error('daemon refused');
          return `bytes from read ${reads}`;
        }}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('bytes from read 1');

    await interact(() => latestOf(() => latest, 'the settled resource').reload());
    // A failed reread is not a failed read: the bytes stay, the failure is told.
    expect(text(view.container)).toBe('bytes from read 1');
    const failed = latestOf(() => latest, 'the failed resource');
    expect(failed.error).toBe('daemon refused');
    expect(failed.stale).toBe(true);
    expect(failed.refreshing).toBe(false);
    expect(failed.loading).toBe(false);
    // A failure must never pretend new bytes landed.
    expect(failed.revision).toBe(1);

    await interact(() => latestOf(() => latest, 'the failed resource').reload());
    expect(text(view.container)).toBe('bytes from read 3');
    const retried = latestOf(() => latest, 'the retried resource');
    expect(retried.error).toBeNull();
    expect(retried.stale).toBe(false);
    expect(retried.revision).toBe(2);
    await view.unmount();
  });

  it('clears the previous key’s data instead of showing it under the new key', async () => {
    const bodies = new Map([
      ['file:a', 'contents of A'],
      ['file:b', 'contents of B'],
    ]);
    let pending: ((value: string) => void) | null = null;
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={async () => bodies.get('file:a') ?? ''}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('contents of A');
    // B's read has not settled yet: the pane must say "loading", never A.
    // Retaining a value across a RELOAD is not retaining it across a key — A's
    // bytes under B's name is exactly what this hook exists to prevent.
    await view.render(
      <Probe
        resourceKey="file:b"
        load={() =>
          new Promise<string>(resolve => {
            pending = resolve;
          })
        }
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('loading');
    const swapped = latestOf(() => latest, 'the resource under the new key');
    expect(swapped.data).toBeNull();
    expect(swapped.loading).toBe(true);
    expect(swapped.stale).toBe(false);
    expect(swapped.refreshing).toBe(false);
    expect(swapped.revision).toBe(0);
    await interact(async () => {
      must(pending, 'the pending read')('contents of B');
    });
    expect(text(view.container)).toBe('contents of B');
    await view.unmount();
  });

  it('drops a response that arrives after the component moved on', async () => {
    let settle: ((value: string) => void) | null = null;
    let resolved = 0;
    const view = await mount(
      <Probe
        resourceKey="file:slow"
        load={() =>
          new Promise<string>(resolve => {
            settle = value => {
              resolved += 1;
              resolve(value);
            };
          })
        }
        onResource={() => {}}
      />,
    );
    await view.unmount();
    await interact(async () => {
      must(settle, 'the stalled read')('too late');
    });
    expect(resolved).toBe(1);
  });

  it('does not turn an aborted read into an error the reader has to dismiss', async () => {
    const view = await mount(
      <Probe
        resourceKey="file:aborted"
        load={async signal => {
          await Promise.resolve();
          const error = new Error('aborted');
          error.name = 'AbortError';
          expect(signal.aborted).toBe(false);
          throw error;
        }}
        onResource={() => {}}
      />,
    );
    expect(text(view.container)).toBe('loading');
    await view.unmount();
  });
});
