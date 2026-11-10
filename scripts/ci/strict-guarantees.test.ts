import { expect, test } from 'bun:test';
import { byOwner, NO_OWNER, ownerOf, summary } from './strict-guarantees.ts';

const miss = (where: string, message: string) => ({ check: 'guarantees', where, message });
const NO_TEST = (id: string, owner: string) => miss(id, `kept row owned by ${owner} has no test named "${id} …"`);

test('the misses are grouped by owner, sorted, one id once', () => {
  const findings = [
    NO_TEST('G9', 'warden'),
    NO_TEST('G2', 'access'),
    miss('G9', 'kept row owned by warden has a FAILING test: x'),
    miss('G5', 'split row owned by access has a test named "G5 …" but no passing run of it in the results'),
    miss('G3', 'REMOVED row still has a test (a.test.ts); its code remains'),
  ];
  expect(ownerOf(findings[4]!)).toBe(NO_OWNER);
  expect([...byOwner(findings)]).toEqual([
    [NO_OWNER, ['G3']],
    ['access', ['G2', 'G5']],
    ['warden', ['G9']],
  ]);
});

test('the summary leads with the count and says whether it blocks', () => {
  const text = summary([NO_TEST('G2', 'access'), NO_TEST('G9', 'warden')], false);
  expect(text.split('\n')[0]).toContain('2 missing');
  expect(text).toContain('report only');
  expect(text).toContain('| access | 1 | G2 |');
  expect(summary([NO_TEST('G2', 'access')], true)).toContain('BLOCKING');
  expect(summary([], false)).toContain('0 missing');
});

test('no report at all is reported as unknown, not as a miss', () => {
  const text = summary([miss('results', 'no JUnit report found')], false);
  expect(text).toContain('unknown');
  expect(text).not.toContain('1 missing');
});
