import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { WardenPage, type WardenSurfaceProps } from '../../../src/lib/pages/warden-page.tsx';
import { interact, type Mounted, mount } from '../../support/dom.ts';

describe('WardenPage', () => {
  it('should mount the daemon-bound overview inside one labelled scroll region', () => {
    // Arrange
    const connection = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceId: 'device-secret',
    });
    const received: DaemonConnection[] = [];
    const Overview = ({ connection: actual }: WardenSurfaceProps) => {
      received.push(actual);
      return <div data-surface="overview">overview</div>;
    };

    // Act
    const html = renderToStaticMarkup(<WardenPage connection={connection} slots={{ Overview }} />);

    // Assert
    should(html).startWith('<main aria-label="Warden"');
    should(html).containEql('overflow-y-auto');
    should(html).containEql('data-surface="overview"');
    should(received).have.length(1);
    should(received[0]).equal(connection);
    should(html).not.containEql('device-secret');
    should(html).not.containEql('daemon-a');
  });
});

describe('WardenPage across daemons', () => {
  const ec2 = daemonConnection({ daemonId: 'daemon-ec2', baseUrl: 'https://ec2.example.test', deviceId: 'tok-a' });
  const mbp = daemonConnection({ daemonId: 'daemon-mbp', baseUrl: 'https://mbp.example.test', deviceId: 'tok-b' });
  const machines = [
    { connection: ec2, name: 'Liftoff EC2' },
    { connection: mbp, name: 'Liftoff MBP' },
  ];
  const Overview = ({ connection, machineName }: WardenSurfaceProps) => (
    <div data-surface="overview" data-daemon={connection.daemonId} data-machine={machineName ?? ''}>
      overview
    </div>
  );
  const rendered = (view: Mounted) =>
    [...view.container.querySelectorAll('[data-surface="overview"]')].map(node => node.getAttribute('data-machine'));
  const filter = (view: Mounted) => view.container.querySelector<HTMLSelectElement>('select[aria-label="Daemon"]');

  it('should offer All plus each paired daemon, and show one named overview per daemon under All', async () => {
    const view = await mount(
      <WardenPage connection={ec2} slots={{ Overview }} machines={machines} remembered={null} onRemember={() => {}} />,
    );
    const select = filter(view);
    expect(select).not.toBeNull();
    expect([...(select?.options ?? [])].map(option => [option.value, option.textContent])).toEqual([
      ['', 'All daemons'],
      ['daemon-ec2', 'Liftoff EC2'],
      ['daemon-mbp', 'Liftoff MBP'],
    ]);
    expect(select?.value).toBe('');
    expect(rendered(view)).toEqual(['Liftoff EC2', 'Liftoff MBP']);
    await view.unmount();
  });

  it('should show only the remembered daemon, and say which one it is', async () => {
    const view = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview }}
        machines={machines}
        remembered="daemon-mbp"
        onRemember={() => {}}
      />,
    );
    expect(filter(view)?.value).toBe('daemon-mbp');
    expect(rendered(view)).toEqual(['Liftoff MBP']);
    await view.unmount();
  });

  it('should report a choice, with null for All', async () => {
    const chosen: (string | null)[] = [];
    const view = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview }}
        machines={machines}
        remembered={null}
        onRemember={id => chosen.push(id)}
      />,
    );
    const select = filter(view);
    await interact(() => {
      if (select === null) return;
      select.value = 'daemon-ec2';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await interact(() => {
      if (select === null) return;
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(chosen).toEqual(['daemon-ec2', null]);
    await view.unmount();
  });

  it('should draw the combined totals above the sections under All only', async () => {
    const Totals = ({ machines: shown }: { readonly machines: readonly (typeof machines)[number][] }) => (
      <div data-totals={shown.map(machine => machine.name).join('+')} />
    );
    const totalsOf = (view: Mounted) => view.container.querySelector('[data-totals]')?.getAttribute('data-totals');
    const all = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview, Totals }}
        machines={machines}
        remembered={null}
        onRemember={() => {}}
      />,
    );
    expect(totalsOf(all)).toBe('Liftoff EC2+Liftoff MBP');
    await all.unmount();
    const one = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview, Totals }}
        machines={machines}
        remembered="daemon-mbp"
        onRemember={() => {}}
      />,
    );
    expect(totalsOf(one)).toBeUndefined();
    await one.unmount();
  });

  it('should offer no filter and no machine name for a single paired daemon', async () => {
    const view = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview }}
        machines={[machines[0] as (typeof machines)[number]]}
        remembered={null}
        onRemember={() => {}}
      />,
    );
    expect(filter(view)).toBeNull();
    expect(rendered(view)).toEqual(['']);
    await view.unmount();
  });
});
