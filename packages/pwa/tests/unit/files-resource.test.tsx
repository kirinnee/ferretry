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
  return <output>{resource.loading ? 'loading' : (resource.error ?? resource.data ?? 'idle')}</output>;
};

const text = (container: HTMLElement): string =>
  must(container.querySelector('output'), 'the probe output').textContent ?? '';

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

  it('loads, then reports an error for a key that fails', async () => {
    let fail = false;
    const load = async (): Promise<string> => {
      if (fail) throw new Error('daemon refused');
      return 'file bytes';
    };
    let latest: FsResource<string> | null = null;
    const view = await mount(
      <Probe
        resourceKey="file:a"
        load={load}
        onResource={resource => {
          latest = resource;
        }}
      />,
    );
    expect(text(view.container)).toBe('file bytes');
    fail = true;
    await interact(() => {
      must(latest, 'the latest resource').reload();
    });
    expect(text(view.container)).toBe('daemon refused');
    await view.unmount();
  });

  it('clears the previous key’s data instead of showing it under the new key', async () => {
    const bodies = new Map([
      ['file:a', 'contents of A'],
      ['file:b', 'contents of B'],
    ]);
    let pending: ((value: string) => void) | null = null;
    const view = await mount(
      <Probe resourceKey="file:a" load={async () => bodies.get('file:a') ?? ''} onResource={() => {}} />,
    );
    expect(text(view.container)).toBe('contents of A');
    // B's read has not settled yet: the pane must say "loading", never A.
    await view.render(
      <Probe
        resourceKey="file:b"
        load={() =>
          new Promise<string>(resolve => {
            pending = resolve;
          })
        }
        onResource={() => {}}
      />,
    );
    expect(text(view.container)).toBe('loading');
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
