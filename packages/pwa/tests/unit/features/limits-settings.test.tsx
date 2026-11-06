import { describe, expect, it } from 'bun:test';
import type { IFyApiClient, LimitsView } from '@ferretry/protocol';
import { cgroupConfigView } from '../../../../protocol/tests/fixtures.ts';
import { LimitsCard, LimitsSurface, limitsBadge } from '../../../src/features/settings/limits-settings.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { render, run, runAsync } from '../../support/react.ts';

const connection = (id: string) =>
  daemonConnection({ daemonId: id, baseUrl: `https://${id}.example.test`, deviceId: `token-${id}` });

const view = (over: Partial<LimitsView> = {}): LimitsView => ({ ...cgroupConfigView, ...over });

describe('LimitsCard', () => {
  it('draws the daemon’s own sentences, word for word, and says where to change them', () => {
    const renderer = render(<LimitsCard view={view()} />);
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(cgroupConfigView.lines[0] as string);
    expect(text).toContain('limits.yaml');
    expect(text).toContain('waits for you to confirm');
    expect(text).toContain('Ferrets already running keep the limits they started with');
    expect(text).not.toContain('cgroup');
    expect(text).not.toContain('MemoryHigh');
  });

  it('badges what is true: enforced, priority only, not enforced, switched off', () => {
    expect(limitsBadge(view())).toEqual({ text: 'enforced', good: true });
    expect(limitsBadge(view({ enforcement: 'priority' }))).toEqual({ text: 'priority only', good: true });
    expect(limitsBadge(view({ enforcement: 'none' }))).toEqual({ text: 'not enforced', good: false });
    expect(limitsBadge(view({ switchedOn: false, enforcement: 'none' }))).toEqual({
      text: 'switched off',
      good: false,
    });
  });

  it('shows why nothing is enforced, and every warning, as alerts', () => {
    const renderer = render(
      <LimitsCard
        view={view({
          enforcement: 'none',
          lines: ['limits not enforced: the user’s systemd manager does not answer'],
          warnings: ['this daemon is itself inside the fleet slice'],
        })}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('limits not enforced: the user’s systemd manager does not answer');
    expect(text).toContain('this daemon is itself inside the fleet slice');
    expect(text).toContain('not enforced');
  });

  it('lists ferrets slowed or stopped for memory as the daemon words them', () => {
    const renderer = render(
      <LimitsCard
        view={view({
          lines: [
            ...cgroupConfigView.lines,
            '2 ferrets slowed for memory now',
            'killed for memory: gertrude 23:04 (bun test, 9.1 GiB)',
          ],
        })}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('2 ferrets slowed for memory now');
    expect(text).toContain('killed for memory: gertrude 23:04 (bun test, 9.1 GiB)');
  });
});

describe('LimitsSurface', () => {
  const client = (read: () => Promise<LimitsView>) => async () =>
    ({ cgroupConfig: read }) satisfies Pick<IFyApiClient, 'cgroupConfig'>;
  const settle = async () =>
    await runAsync(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

  it('reads the limits and draws them', async () => {
    const renderer = render(<LimitsSurface connection={connection('a')} createClient={client(async () => view())} />);
    await settle();
    expect(JSON.stringify(renderer.toJSON())).toContain('Ferret limits');
    expect(JSON.stringify(renderer.toJSON())).toContain(cgroupConfigView.lines[0] as string);
  });

  it('says it could not tell, rather than assuming limits are on or off, when the daemon does not answer', async () => {
    const renderer = render(
      <LimitsSurface
        connection={connection('a')}
        createClient={client(async () => {
          throw new Error('offline');
        })}
      />,
    );
    await settle();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Ferret limits unavailable');
    expect(text).toContain('will not assume they are on or off');
    expect(text).toContain('offline');
  });

  it('cleans up an in-flight daemon read when the surface unmounts', async () => {
    let resolve: ((value: LimitsView) => void) | undefined;
    const delayed = new Promise<LimitsView>(next => {
      resolve = next;
    });
    const renderer = render(<LimitsSurface connection={connection('a')} createClient={client(async () => delayed)} />);
    run(() => renderer.unmount());
    await runAsync(async () => {
      resolve?.(view());
      await Promise.resolve();
    });
    expect(renderer.toJSON()).toBeNull();
  });
});
