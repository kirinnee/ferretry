import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { daemonConnection, type DaemonId } from '../../../src/lib/daemon-connection.ts';
import { PageHost, type PageHostSlots } from '../../../src/lib/pages/page-host.tsx';
import { daemonQueuePath, type PageRoute, parseRoute, routePageKey, routePath } from '../../../src/lib/pages/routes.ts';

const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'device' });
const pageRoute = (path: string): PageRoute => parseRoute(path) as PageRoute;
const alphaId = 'daemon-a' as DaemonId;
const unused = (): never => {
  throw new Error('a daemon page must not render');
};
const slots: PageHostSlots = {
  ConnectionPicker: unused,
  Setup: unused,
  Home: unused,
  Sessions: unused,
  NewSession: unused,
  SessionChat: unused,
  Settings: unused,
  Warden: unused,
  Analytics: unused,
  Learning: unused,
  Queue: ({ sessionId }) => <p>queue:{sessionId ?? 'all'}</p>,
};

describe('the queue route', () => {
  it('reads and writes All queues and one ferret’s queue', () => {
    expect(parseRoute('/d/daemon-a/queue')).toEqual({ kind: 'queue', daemonId: alphaId });
    const one = parseRoute('/d/daemon-a/queue/sess%201');
    expect(one).toEqual({ kind: 'queue', daemonId: alphaId, sessionId: 'sess 1' });
    expect(routePath(one)).toBe(daemonQueuePath(alphaId, 'sess 1'));
    expect(routePath(parseRoute('/d/daemon-a/queue'))).toBe('/d/daemon-a/queue');
    expect(routePageKey(one)).toBe('queue:"daemon-a"');
  });

  it('mounts the Queue slot with the ferret the address names, and says so when it is not mounted', () => {
    const html = (path: string) =>
      renderToStaticMarkup(<PageHost route={pageRoute(path)} connection={connection} slots={slots} />);
    expect([html('/d/daemon-a/queue'), html('/d/daemon-a/queue/s1')]).toEqual(['<p>queue:all</p>', '<p>queue:s1</p>']);
    expect(() =>
      renderToStaticMarkup(
        <PageHost
          route={pageRoute('/d/daemon-a/queue')}
          connection={connection}
          slots={{ ...slots, Queue: undefined }}
        />,
      ),
    ).toThrow('the queue route is not mounted');
  });
});
