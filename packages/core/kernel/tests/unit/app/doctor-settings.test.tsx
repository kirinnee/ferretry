import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DoctorReportView } from '../../../app/doctor/doctor-settings.tsx';
import { type DoctorReport, notBuiltSummary } from '../../../contract/doctor.ts';

const check = (name: string, summary: string, status: DoctorReport['checks'][number]['status'] = 'present') => ({
  name,
  requirement: 'required' as const,
  status,
  summary,
  impact: 'Sessions cannot start.',
});

const report = (checks: DoctorReport['checks']): DoctorReport => ({
  checks,
  harnesses: [],
  ready: true,
  limitation: 'Presence is not a sign-in.',
});

describe('Settings › Doctor', () => {
  test('groups the checks nobody has built into one collapsed line instead of a wall of rows', () => {
    const markup = renderToStaticMarkup(
      <DoctorReportView
        report={report([
          check('bash', 'bash is on the PATH'),
          check('board-store', notBuiltSummary('board-store'), 'unavailable_by_design'),
          check('agenda-buzz', notBuiltSummary('agenda-buzz'), 'unavailable_by_design'),
        ])}
      />,
    );
    expect(markup).toContain('data-doctor-check="bash"');
    expect(markup).not.toContain('data-doctor-check="board-store"');
    expect(markup).toContain('2 checks are not built yet in this build, so nothing was checked');
    expect(markup).toContain('board-store, agenda-buzz');
    expect(markup.match(/data-doctor-unbuilt/gu)).toHaveLength(1);
  });

  test('draws no such line when every check is real, and never doubles a full stop', () => {
    const markup = renderToStaticMarkup(
      <DoctorReportView report={report([check('git', 'git was not found on the PATH.', 'missing')])} />,
    );
    expect(markup).not.toContain('data-doctor-unbuilt');
    expect(markup).toContain('git was not found on the PATH. Sessions cannot start.');
    expect(markup).not.toContain('..');
  });
});
