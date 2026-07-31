import { describe, it } from 'bun:test';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { WardenPage, type WardenPageSlots, type WardenSurfaceProps } from '../../../src/lib/pages/warden-page.tsx';

describe('WardenPage', () => {
  it('should compose the daemon-bound surfaces in outcome-first order', () => {
    // Arrange
    const connection = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'device-secret',
    });
    const received: DaemonConnection[] = [];
    const surface = (name: string): ComponentType<WardenSurfaceProps> =>
      function Surface({ connection: actual }) {
        received.push(actual);
        return <div data-surface={name}>{name}</div>;
      };
    const slots: WardenPageSlots = {
      Attention: surface('attention'),
      Status: surface('status'),
      Configuration: surface('configuration'),
      Verdicts: surface('verdicts'),
    };

    // Act
    const html = renderToStaticMarkup(<WardenPage connection={connection} slots={slots} />);

    // Assert
    should(html).containEql('aria-labelledby="warden-heading"');
    should(html).containEql('>Warden</h1>');
    should(html).containEql('Who needs you, then sweeps, accounts, and recent verdicts.');
    should(html).containEql('id="config"');
    should(html.indexOf('data-surface="status"')).be.above(html.indexOf('data-surface="attention"'));
    should(html.indexOf('data-surface="configuration"')).be.above(html.indexOf('data-surface="status"'));
    should(html.indexOf('data-surface="verdicts"')).be.above(html.indexOf('data-surface="configuration"'));
    should(received).have.length(4);
    for (const actual of received) should(actual).equal(connection);
    should(html).not.containEql('device-secret');
    should(html).not.containEql('daemon-a');
  });
});
