import { describe, expect, test } from 'bun:test';
import {
  reportLine,
  reportOf,
  summarize,
  renderClosing,
  renderSummaryJson,
  row,
  statusLine,
} from '../../../cli/lib/summary.ts';
import { linkCosts } from '../../../cli/lib/words.ts';
import { step } from './fixtures.ts';

describe('first-run summary', () => {
  test('a row is a mark, the title padded to the widest, and the sentence', () => {
    expect(row(step('a', 'x', 'Sign in', 30, 'found'), 'found: ok', 11)).toBe('  ✓ Sign in      found: ok');
    expect(row(step('a', 'x', 'Shells', 80, 'later'), 'left for later', 6)).toBe('  - Shells  left for later');
    expect(row(step('a', 'x', 'Shells', 80), 'not looked at yet', 6)).toBe('  ! Shells  not looked at yet');
  });

  test('each state has its own word', () => {
    expect(
      ['pending', 'found', 'later', 'done', 'skipped'].map(state => statusLine(step('a', 'x', 'T', 1, state as never))),
    ).toEqual(['not looked at yet', 'found', 'left for later', 'done', 'skipped']);
  });

  test('a reading becomes a report: found, missing with its remedy, unreadable with its reason', () => {
    const pending = step('shells', 'nix', 'Shells', 80);
    expect(reportOf(pending, { kind: 'found', line: 'ok' })).toEqual({ step: pending, line: 'ok', check: 'found' });
    expect(reportOf(pending, { kind: 'found', line: 'ok', linked: true }).linked).toBe(true);
    expect(reportOf(pending, { kind: 'missing', line: 'gone', remedy: 'fix' })).toEqual({
      step: pending,
      line: 'gone',
      check: 'missing',
      remedy: 'fix',
    });
    expect(reportOf(pending, { kind: 'unreadable', reason: 'paused' }).line).toBe('Could not check (paused).');
    expect(reportOf(pending, undefined)).toEqual({
      step: pending,
      line: 'Nothing to look for here.',
      check: 'unchecked',
    });
  });

  test('report lines say what happened to the step', () => {
    const base = { line: 'nix is gone.', check: 'missing' as const };
    expect(reportLine({ ...base, step: step('s', 'n', 'Shells', 1, 'later') })).toBe('nix is gone. Left for later.');
    expect(reportLine({ ...base, step: step('s', 'n', 'Shells', 1, 'skipped') })).toBe('nix is gone. Skipped.');
    expect(reportLine({ ...base, step: step('s', 'n', 'Shells', 1) })).toBe('nix is gone.');
    expect(reportLine({ line: 'fine', check: 'found', step: step('s', 'n', 'Shells', 1, 'found') })).toBe(
      'found: fine',
    );
  });

  test('complete means none pending; the exit code is 0 or 2', () => {
    const done = summarize([{ step: step('a', 'x', 'A', 1, 'found'), line: 'ok', check: 'found' }]);
    expect(done).toMatchObject({ complete: true, exitCode: 0, next: [] });
    const waiting = summarize([
      { step: step('a', 'x', 'A', 1), line: 'gone', check: 'missing', remedy: 'do it' },
      { step: step('b', 'y', 'B', 2), line: 'who knows', check: 'unreachable' },
    ]);
    expect(waiting).toMatchObject({ complete: false, exitCode: 2, next: [{ step: 'A', why: 'do it' }] });
  });

  test('the JSON summary has no field that could carry a credential', () => {
    const json = JSON.parse(
      renderSummaryJson(
        summarize([{ step: step('a', 'x', 'A', 1, 'found'), line: 'ok', check: 'found', linked: true }]),
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['complete', 'exitCode', 'linkedSignIn', 'next', 'schema', 'steps']);
    expect(Object.keys((json.steps as object[])[0] ?? {}).sort()).toEqual([
      'check',
      'id',
      'line',
      'order',
      'plugin',
      'state',
      'title',
    ]);
  });

  test('the closing says how many steps still need you and lists what was left for later', () => {
    const summary = summarize([
      { step: step('a', 'x', 'A', 1, 'later'), line: 'gone', check: 'missing' },
      { step: step('b', 'y', 'B', 2), line: 'gone', check: 'missing', remedy: 'do it' },
    ]);
    expect(renderClosing(summary)).toBe(
      ['1 of 2 steps still need you.', 'Left for later: A.', '', 'Next:', '  1. B: do it'].join('\n'),
    );
  });

  test('the linked costs are one line that names the three costs and the way out', () => {
    const line = linkCosts('fy');
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toMatch(/share your quota/);
    expect(line).toMatch(/signing out in your terminal signs them out/);
    expect(line).toMatch(/Usage cannot tell your spend from theirs/);
    expect(line).toMatch(/separate Ferretry login/);
  });
});
