import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { type DaemonConnection, daemonConnection } from '../../../app/lib/machine.ts';
import { WardenPage, type WardenSurfaceProps } from '../../../app/lib/warden-page.tsx';
import { type Mounted, mount } from '@ferretry/app/testing';
import { boxLabelled, choose, openBox, optionLabels, shownBy } from '../../support/app/select-box.ts';

describe('WardenPage', () => {
  it('should mount the daemon-bound overview inside one labelled scroll region', () => {
    // Arrange
    const connection = daemonConnection({
      daemonId: 'daemon-a',
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
  const ec2 = daemonConnection({ daemonId: 'daemon-ec2' });
  const mbp = daemonConnection({ daemonId: 'daemon-mbp' });
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
  const filter = (view: Mounted) => boxLabelled(view.container, 'Daemon');

  it('should offer All plus each paired daemon, and show one named overview per daemon under All', async () => {
    const view = await mount(
      <WardenPage connection={ec2} slots={{ Overview }} machines={machines} remembered={null} onRemember={() => {}} />,
    );
    const select = filter(view);
    await openBox(select);
    expect(optionLabels()).toEqual(['All daemons', 'Liftoff EC2', 'Liftoff MBP']);
    expect(shownBy(select)).toBe('All daemons');
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
    expect(shownBy(filter(view))).toBe('Liftoff MBP');
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
    await choose(filter(view), 'Liftoff EC2');
    expect(chosen).toEqual(['daemon-ec2']);
    await view.unmount();
    // Picking All from a remembered daemon reports null (picking what is already shown reports nothing, as a native select did not either).
    const again = await mount(
      <WardenPage
        connection={ec2}
        slots={{ Overview }}
        machines={machines}
        remembered="daemon-ec2"
        onRemember={id => chosen.push(id)}
      />,
    );
    await choose(filter(again), 'All daemons');
    expect(chosen).toEqual(['daemon-ec2', null]);
    await again.unmount();
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
    expect(view.container.querySelector('[role="combobox"]')).toBeNull();
    expect(rendered(view)).toEqual(['']);
    await view.unmount();
  });
});
