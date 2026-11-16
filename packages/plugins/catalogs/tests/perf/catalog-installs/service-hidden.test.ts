import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, ROOT, STEP_UP } from '../../unit/catalog-installs/service-support.ts';

// The speed half of `tests/unit/catalog-installs/service-hidden.test.ts`: a 2 MiB file on disk is answered in bounded
// time. The unit file runs the same shapes at a small size and proves the answer.
let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const FOLDER = `${ROOT}/.claude/skills/pdf-tools`;
const skillV = (version: number, content: string) =>
  skillItem(alice.daemonId, { itemVersion: version, files: [{ path: 'SKILL.md', content }] });

describe('a large file on disk is previewed in bounded time', () => {
  it.each([
    ['a 2 MiB single line', 'a'.repeat(2 * 1024 * 1024)],
    ['2 MiB of short lines', 'ab\n'.repeat((2 * 1024 * 1024) / 3)],
    [
      '2 MiB of nested block openers',
      Array.from({ length: (2 * 1024 * 1024) / 16 }, (_, depth) => `${' '.repeat(depth % 8)}pw: |`).join('\n'),
    ],
    ['2 MiB of repeated token prefixes', 'sk-'.repeat((2 * 1024 * 1024) / 3)],
  ])('should answer %s on disk in bounded time', async (_label, text) => {
    const r = rig();
    const first = await r.service.preview('project', await request(alice, skillV(1, '# one\n'), projectTarget()));
    await r.service.apply('project', { previewId: first.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    r.folders.folders.get(FOLDER)?.set('SKILL.md', text);
    const started = performance.now();
    await r.service.preview(
      'project',
      await request(alice, skillV(2, '# two\n'), projectTarget(), { replaceEdited: true }),
    );
    should(performance.now() - started).be.below(15_000);
  });
});
