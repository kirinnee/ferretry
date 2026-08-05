import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { WardenReportDialog } from '../../../src/features/warden/warden-report-dialog.tsx';
import type { WardenReportDialogRequest } from '../../../src/features/warden/warden-report-dialog.tsx';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';

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

  it('calls unreadable evidence unavailable rather than leaving an empty report', async () => {
    const source = await Bun.file(
      new URL('../../../src/features/warden/warden-report-dialog.tsx', import.meta.url),
    ).text();

    expect(source).toContain('setUnavailable(true)');
    expect(source).toContain('Report evidence unavailable');
    expect(source).toContain('not being treated as an empty or healthy verdict');
  });
});
