import { describe, expect, it } from 'bun:test';

import { daemonId } from '../../src/lib/daemon-connection.ts';
import { sessionReferenceHost } from '../../src/lib/reference-host.ts';

describe('sessionReferenceHost', () => {
  it('falls back to the session on the daemon that owns every reference', () => {
    const destinations: string[] = [];
    const host = sessionReferenceHost(daemonId('daemon-a'), 'same-session', to => destinations.push(to));

    host.onTaskOpen?.('F12');
    host.onCodeReferenceOpen?.({ path: 'src/app.ts', line: 4 });
    host.onAttentionOpen?.('A3');

    expect(destinations).toEqual([
      '/d/daemon-a/session/same-session',
      '/d/daemon-a/session/same-session',
      '/d/daemon-a/session/same-session',
    ]);
  });

  it('offers no false destination when a row is not associated with a session', () => {
    expect(sessionReferenceHost(daemonId('daemon-a'), null, () => {})).toEqual({});
    expect(sessionReferenceHost(daemonId('daemon-a'), '   ', () => {})).toEqual({});
  });
});
