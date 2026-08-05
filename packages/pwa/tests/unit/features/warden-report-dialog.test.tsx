import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { WardenReportDialog } from '../../../src/features/warden/warden-report-dialog.tsx';
import type { WardenReportDialogRequest } from '../../../src/features/warden/warden-report-dialog.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { interact, mount } from '../../support/dom.ts';

const connection = daemonConnection({
  daemonId: 'daemon-a',
  baseUrl: 'https://daemon-a.example.test',
  deviceToken: 'device-token-a',
});

const request: WardenReportDialogRequest = {
  connection,
  verdict: {
    at: '2026-07-31T11:58:00.000Z',
    targetSession: 'session-a',
    verdict: 'needs_human',
    reportPath: '/state/warden/reports/2026-07-31-session-a.md',
  },
};

describe('WardenReportDialog', () => {
  it('keeps the full report reachable in a labelled dialog', () => {
    const tree = renderToStaticMarkup(
      <WardenReportDialog request={request} read={async () => '# Evidence'} onClose={() => {}} />,
    );

    expect(tree).toContain('2026-07-31-session-a.md');
    expect(tree).toContain('Loading report evidence');
    expect(tree).toContain('role="dialog"');
    expect(tree).not.toContain('device-token-a');
  });

  it('renders loaded and unreadable evidence states instead of turning either into an empty report', async () => {
    const loaded = await mount(
      <WardenReportDialog request={request} read={async () => '# Evidence'} onClose={() => {}} />,
    );
    await interact(async () => await Promise.resolve());
    expect(loaded.container.textContent).toContain('Evidence');
    await loaded.unmount();

    const unreadable = await mount(
      <WardenReportDialog
        request={request}
        read={async () => await Promise.reject(new Error('unreadable'))}
        onClose={() => {}}
      />,
    );
    await interact(async () => await Promise.resolve());
    expect(unreadable.container.textContent).toContain('Report evidence unavailable');
    expect(unreadable.container.textContent).toContain('not being treated as an empty or healthy verdict');
    await unreadable.unmount();
  });
});
