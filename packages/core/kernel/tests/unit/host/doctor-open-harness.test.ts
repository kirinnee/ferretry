import { describe, expect, it } from 'bun:test';
import { DoctorHarnessSchema, DoctorReportSchema } from '../../../contract/doctor.ts';

/** The doctor lists launchability per harness by the family word it is given: a harness the kernel never named is listed too. */
describe('the doctor report for a harness the kernel never named', () => {
  it('reads a harness row of any kind, and still reads the two shipped', () => {
    for (const kind of ['claude', 'codex', 'fake-third']) {
      expect(DoctorHarnessSchema.parse({ kind, launchable: ['fixture'], blocked: [] }).kind).toBe(kind);
    }
    const report = {
      checks: [],
      harnesses: [{ kind: 'fake-third', launchable: [], blocked: ['fixture'] }],
      ready: false,
      limitation: 'fixture',
    };
    expect(DoctorReportSchema.parse(report).harnesses[0]?.kind).toBe('fake-third');
  });

  it('refuses an empty kind', () => {
    expect(DoctorHarnessSchema.safeParse({ kind: '', launchable: [], blocked: [] }).success).toBe(false);
  });
});
