import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

/** The parts of Ferretry that write into a ferret's chat; the app draws each as a system row from this metadata. */
const FEATURES = new Set([
  'Board',
  'Agenda',
  'Monitor',
  'Lessons',
  'Warden',
  'Migrate',
  'Instructions',
  'Restart',
  'Delivery',
]);

const FILES = ['bin/fyd.ts', 'src/lib/session/send/notifier.ts', 'src/lib/session/queue/queueing-sends.ts'];

describe('every sender that is Ferretry itself carries sender metadata', () => {
  test('each producer front names a known feature', () => {
    const source = read('bin/fyd.ts');
    const named = [...source.matchAll(/producerSends\('([A-Za-z]+)'\)/gu)].map(match => match[1] as string);
    expect(named.length).toBeGreaterThan(3);
    for (const feature of named) expect(FEATURES.has(feature)).toBe(true);
    const fronts = [...source.matchAll(/new QueueingSends\(queueingPorts, '(?:daemon|human)', '([A-Za-z]+)'\)/gu)];
    for (const front of fronts) expect(FEATURES.has(front[1] as string)).toBe(true);
  });

  test('a direct send made as the daemon says who sent it', () => {
    for (const file of FILES) {
      const source = read(file);
      for (const match of source.matchAll(/origin: 'daemon',/gu)) {
        const around = source.slice(Math.max(0, (match.index ?? 0) - 400), (match.index ?? 0) + 200);
        // The queue deliverer re-sends what the queue already attributed; every other site names itself.
        if (file.endsWith('send-path-delivery.ts')) continue;
        expect(around).toMatch(/by: (\{ kind: 'ferretry', feature: '[A-Za-z]+' \}|this\.authorOf\(sender\))/u);
      }
    }
  });

  test('every explicit Ferretry author names a known feature', () => {
    for (const file of [...FILES, 'src/lib/session/resume/policy.ts']) {
      for (const match of read(file).matchAll(/kind: 'ferretry', feature: '([A-Za-z]+)'/gu))
        expect(FEATURES.has(match[1] as string)).toBe(true);
    }
  });
});
