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

  it('drops the failure the moment its replacement is asked for', async () => {
    let release: ((value: string) => void) | null = null;
    let reads = 0;
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={() => {
          reads += 1;
          if (reads === 1) return Promise.resolve('the bytes that stayed');
          if (reads === 2) return Promise.reject(new Error('daemon refused'));
          return new Promise<string>(resolve => {
            release = resolve;
          });
        }}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('the bytes that stayed');
    await interact(() => latestOf(() => latest, 'the settled resource').reload());
    expect(latestOf(() => latest, 'the failed resource').error).toBe('daemon refused');

    // The retry is the newer fact. A settled failure and an unsettled attempt
    // are different states, and every consumer reads that off this one place —
    // so the error goes when the read that replaces it starts, not when it ends.
    await interact(() => latestOf(() => latest, 'the failed resource').reload());
    const retrying = latestOf(() => latest, 'the retrying resource');
    expect(retrying.error).toBeNull();
    expect(retrying.refreshing).toBe(true);
    expect(retrying.stale).toBe(true);
    expect(retrying.data).toBe('the bytes that stayed');
    expect(retrying.revision).toBe(1);

    await interact(async () => {
      must(release, 'the stalled retry')('the bytes that replaced them');
    });
    expect(text(view.container)).toBe('the bytes that replaced them');
    expect(latestOf(() => latest, 'the retried resource').revision).toBe(2);
    await view.unmount();
  });

  it('does not ask again for a key it already answered, when that key is merely re-armed', async () => {
    let reads = 0;
    let latest: FsResource<string> | null = null;
    const load = async (): Promise<string> => {
      reads += 1;
      return `bytes from read ${reads}`;
    };
    const probe = (resourceKey: string | null) => (
      <Probe
        resourceKey={resourceKey}
        load={load}
        onResource={resource => {
          latest = resource;
        }}
      />
    );
    const view = await mount(probe('file:a'));
    expect(text(view.container)).toBe('bytes from read 1');

    // A surface that flips to the diff and back drops the key and re-arms it.
    // The value is still here, and asking again would spend a round trip on
    // bytes the reader is already looking at while `refreshing` said nothing.
    await view.render(probe(null));
    await view.render(probe('file:a'));
    expect(reads).toBe(1);
    const rearmed = latestOf(() => latest, 're-armed resource');
    expect(rearmed.data).toBe('bytes from read 1');
    expect(rearmed.refreshing).toBe(false);
    expect(rearmed.loading).toBe(false);
    expect(rearmed.revision).toBe(1);

    // Reload is how newer bytes are asked for; it moves the generation.
    await interact(() => latestOf(() => latest, 're-armed resource').reload());
    expect(reads).toBe(2);
    expect(text(view.container)).toBe('bytes from read 2');
    await view.unmount();
  });

  it('does ask again when the key it re-arms had FAILED, because nothing else can retry it', async () => {
    let reads = 0;
    const load = async (): Promise<string> => {
      reads += 1;
      if (reads === 1) throw new Error('daemon refused');
      return 'bytes from the second attempt';
    };
    const probe = (resourceKey: string | null) => <Probe resourceKey={resourceKey} load={load} onResource={() => {}} />;
    const view = await mount(probe('file:a'));
    expect(text(view.container)).toBe('daemon refused');

    await view.render(probe(null));
    await view.render(probe('file:a'));
    expect(reads).toBe(2);
    expect(text(view.container)).toBe('bytes from the second attempt');
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
