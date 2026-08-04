import { describe, it } from 'bun:test';
import type { ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import should from 'should';

import { type DaemonConnection, daemonConnection } from '../../../src/lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../../src/lib/daemon-scope.ts';
import {
  type DaemonPageProps,
  PageHost,
  type PageHostSlots,
  type SessionChatPageProps,
} from '../../../src/lib/pages/page-host.tsx';
import { type PageRoute, parseRoute } from '../../../src/lib/pages/routes.ts';

const pageRoute = (path: string): PageRoute => {
  const route = parseRoute(path);
  if (route.kind === 'legacy-tasks-redirect') throw new Error('test path unexpectedly redirected');
  return route;
};

describe('PageHost', () => {
  it('should select every screen and pass the exact route-matched connection', () => {
    // Arrange
    const connection = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://a.example.test',
      deviceToken: 'device-secret',
    });
    const received: DaemonConnection[] = [];
    const daemonPage = (name: string): ComponentType<DaemonPageProps> =>
      function DaemonPage({ connection: actual }) {
        received.push(actual);
        return <div data-page={name}>{name}</div>;
      };
    let receivedScope: DaemonSessionScope | undefined;
    const SessionChat = ({ connection: actual, scope }: SessionChatPageProps) => {
      received.push(actual);
      receivedScope = scope;
      return <div data-page="session">session</div>;
    };
    const slots: PageHostSlots = {
      ConnectionPicker: () => <div data-page="connections">connections</div>,
      Setup: () => <div data-page="setup">setup</div>,
      Sessions: daemonPage('sessions'),
      NewSession: daemonPage('new-session'),
      Projects: daemonPage('projects'),
      SessionChat,
      Settings: daemonPage('settings'),
      Warden: daemonPage('warden'),
      Analytics: daemonPage('analytics'),
      Learning: daemonPage('learning'),
    };
    const paths = [
      '/d/daemon-a',
      '/d/daemon-a/new',
      '/d/daemon-a/projects',
      '/d/daemon-a/session/session-one',
      '/d/daemon-a/settings',
      '/d/daemon-a/warden',
      '/d/daemon-a/analytics',
      '/d/daemon-a/learning',
    ];

    // Act
    const html = paths.map(path =>
      renderToStaticMarkup(<PageHost route={pageRoute(path)} connection={connection} slots={slots} />),
    );

    // Assert
    should(html).deepEqual([
      '<div data-page="sessions">sessions</div>',
      '<div data-page="new-session">new-session</div>',
      '<div data-page="projects">projects</div>',
      '<div data-page="session">session</div>',
      '<div data-page="settings">settings</div>',
      '<div data-page="warden">warden</div>',
      '<div data-page="analytics">analytics</div>',
      '<div data-page="learning">learning</div>',
    ]);
    should(received).have.length(paths.length);
    for (const actual of received) should(actual).equal(connection);
    should(receivedScope).deepEqual({ daemonId: connection.daemonId, sessionId: 'session-one' });
    should(html.join('')).not.containEql('device-secret');
  });

  it('should render the connection picker without inventing a default daemon', () => {
    // Arrange
    const unusedDaemonPage = (): never => {
      throw new Error('a daemon page must not render');
    };
    const slots: PageHostSlots = {
      ConnectionPicker: () => <p>Pair a daemon</p>,
      Setup: () => <p>Set up Ferretry</p>,
      Sessions: unusedDaemonPage,
      NewSession: unusedDaemonPage,
      Projects: unusedDaemonPage,
      SessionChat: unusedDaemonPage,
      Settings: unusedDaemonPage,
      Warden: unusedDaemonPage,
      Analytics: unusedDaemonPage,
      Learning: unusedDaemonPage,
    };

    // Act
    const html = renderToStaticMarkup(<PageHost route={pageRoute('/')} slots={slots} />);
    const setup = renderToStaticMarkup(<PageHost route={pageRoute('/setup')} slots={slots} />);

    // Assert
    should(html).equal('<p>Pair a daemon</p>');
    // Setup is connection-free for the same reason: it is the screen someone
    // sees precisely because they have no daemon yet.
    should(setup).equal('<p>Set up Ferretry</p>');
  });

  it('should reject absent and cross-daemon connections before rendering a daemon page', () => {
    // Arrange
    const route = pageRoute('/d/daemon-a');
    const connection = daemonConnection({
      daemonId: 'daemon-b',
      baseUrl: 'https://b.example.test',
      deviceToken: 'device-b',
    });
    const daemonPage = () => <p>must not render</p>;
    const slots: PageHostSlots = {
      ConnectionPicker: daemonPage,
      Setup: daemonPage,
      Sessions: daemonPage,
      NewSession: daemonPage,
      Projects: daemonPage,
      SessionChat: daemonPage,
      Settings: daemonPage,
      Warden: daemonPage,
      Analytics: daemonPage,
      Learning: daemonPage,
    };

    // Act
    const absent = (): string => renderToStaticMarkup(<PageHost route={route} slots={slots} />);
    const mismatched = (): string =>
      renderToStaticMarkup(<PageHost route={route} connection={connection} slots={slots} />);

    // Assert
    should(absent).throw('a daemon page requires a runtime connection');
    should(mismatched).throw('the runtime connection does not match the route daemon');
  });
});
