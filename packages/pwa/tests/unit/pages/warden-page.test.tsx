import { describe, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { WardenPage, type WardenSurfaceProps } from '../../../src/lib/pages/warden-page.tsx';

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
