import { describe, expect, test } from 'bun:test';
import { reportNamedFor, reportOwnedBy, type WardenReadScope } from '../../daemon/lib/index.ts';

/**
 * Audit A fix 5: a report's raw text goes to a ferret only when EVERY part of it is attributable to the ferret's lineage.
 * `parseWardenReports` drops a section it does not recognise, so it cannot be the authority; `reportOwnedBy` is the strict,
 * fail-closed check. Fixture ids only.
 */

const MINE = 'mw4qug00-62dc19ab';
const HELPER = 'mw4qug00-11111111';
const STRANGER = 'mw4qug00-147650bd';
const WARDEN = 'mw4qug01-aaaaaaaa';
const scope: WardenReadScope = { mayRead: id => id === MINE || id === HELPER };

const file = (name: string) => `/state/reports/${name}.md`;
const fleet = file('2026-11-06T09-00-00-000Z');
const assigned = (id: string) => file(`2026-11-06T09-00-00-000Z-${id}`);
const owned = (content: string, path = fleet, extra: { provenanceTarget?: string; provenanceWarden?: string } = {}) =>
  reportOwnedBy({ path, content, ...extra }, scope);

const block = (id: string, extra = '') => `## Anomaly: ${id} — :Caller / main\nVerdict: LEAVE\n${extra}\n`;

describe('a fleet triage report', () => {
  test('is the lineage’s when every section is a well-formed anomaly for a lineage session', () => {
    expect(owned(`# Warden sweep (2026-11-06T09:00:00.000Z)\n\n${block(MINE)}\n${block(HELPER)}`)).toBe(true);
    expect(owned(`## Anomaly: \`${MINE}\`\nVerdict: LEAVE\n`)).toBe(true);
  });

  test('is nobody’s when any section names a stranger', () => {
    expect(owned(`${block(MINE)}\n${block(STRANGER)}`)).toBe(false);
  });

  test('is nobody’s when a heading mentions an anomaly but names no session the parser could read', () => {
    expect(owned(`${block(MINE)}\n## Anomaly: \nVictim ${STRANGER}\nVerdict: NEEDS_HUMAN\n`)).toBe(false);
    expect(owned(`${block(MINE)}\n## Anomaly: —\nVerdict: NEEDS_HUMAN\n`)).toBe(false);
    expect(owned(`${block(MINE)}\n## Anomaly\nVerdict: NEEDS_HUMAN\n`)).toBe(false);
    expect(owned(`${block(MINE)}\n### Anomalies\nVerdict: NEEDS_HUMAN\n`)).toBe(false);
  });

  test('is nobody’s when it carries any other second-level section', () => {
    expect(owned(`${block(MINE)}\n## Fleet summary\nAll quiet, $4 spent.\n`)).toBe(false);
  });

  test('is nobody’s when a stranger’s id sits in prose, a label or a body, whatever the structure', () => {
    expect(owned(`${block(MINE, `Also see ${STRANGER}.`)}`)).toBe(false);
    expect(owned(`# Sweep of ${STRANGER}\n\n${block(MINE)}`)).toBe(false);
    expect(owned(`## Anomaly: ${MINE} — ${STRANGER} / main\nVerdict: LEAVE\n`)).toBe(false);
  });

  test('is nobody’s when it also carries an assigned header, or a sidecar that names a target', () => {
    expect(owned(`# Warden report — ${MINE}\n\n${block(MINE)}`)).toBe(false);
    expect(owned(block(MINE), fleet, { provenanceTarget: MINE })).toBe(false);
  });

  test('may name the Warden session that wrote it, and no other Warden', () => {
    expect(owned(block(MINE, `Written by ${WARDEN}.`), fleet, { provenanceWarden: WARDEN })).toBe(true);
    expect(owned(block(MINE, `Written by ${WARDEN}.`))).toBe(false);
  });
});

describe('an assigned report', () => {
  const header = (id: string) => `# Warden report — ${id} (teammate Caller, main)\n\n## Summary\n- **Outcome:** fine\n`;

  test('is the lineage’s when its one header names a lineage session and the name and sidecar agree', () => {
    expect(owned(header(MINE), assigned(MINE))).toBe(true);
    expect(owned(header(MINE), assigned(MINE), { provenanceTarget: MINE, provenanceWarden: WARDEN })).toBe(true);
    expect(owned(`# Warden report — ${HELPER}\n`, assigned(HELPER))).toBe(true);
  });

  test('is nobody’s without a well-formed header, or with more than one', () => {
    expect(owned('Verdict: LEAVE\n', assigned(MINE))).toBe(false);
    expect(owned(`# Warden report\nVerdict: LEAVE\n`, assigned(MINE))).toBe(false);
    expect(owned(`${header(MINE)}\n# Warden report — ${STRANGER}\n`, assigned(MINE))).toBe(false);
    expect(owned(`${header(MINE)}\n## Warden report — ${MINE}\n`, assigned(MINE))).toBe(false);
  });

  test('is nobody’s when the header, the file name and the sidecar disagree', () => {
    expect(owned(header(MINE), assigned(HELPER))).toBe(false);
    expect(owned(header(MINE), assigned(MINE), { provenanceTarget: HELPER })).toBe(false);
    expect(owned(header(STRANGER), assigned(STRANGER))).toBe(false);
  });

  test('is nobody’s when empty or when a stranger is mentioned anywhere', () => {
    expect(owned('', assigned(MINE))).toBe(false);
    expect(owned('   \n', assigned(MINE))).toBe(false);
    expect(owned(`${header(MINE)}\n## Evidence\n- ${STRANGER} also stalled\n`, assigned(MINE))).toBe(false);
  });
});

test('a report’s name says whom an assigned report is for, and says nothing of a fleet triage', () => {
  expect(reportNamedFor(assigned(MINE))).toBe(MINE);
  expect(reportNamedFor(fleet)).toBeUndefined();
});
