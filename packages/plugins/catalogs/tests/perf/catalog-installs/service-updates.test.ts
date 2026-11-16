import { beforeAll, describe, it } from 'bun:test';
import should from 'should';
import type { DaemonIdentity } from '../../../daemon/lib/relay-wire/index.ts';
import { newIdentity, skillItem } from '../../support/catalog-fixtures.ts';
import { GOVERNANCE, projectTarget, request, rig, STEP_UP } from '../../unit/catalog-installs/service-support.ts';

// The speed half of the "see changes" cases in `tests/unit/catalog-installs/service-updates.test.ts`: the diff of two
// wholly different 6000-line files is bounded. The unit file proves the answer (marked, truncated) without a clock.
let alice: DaemonIdentity;
beforeAll(async () => {
  alice = await newIdentity();
});

const skillV = (version: number, content: string) =>
  skillItem(alice.daemonId, { itemVersion: version, files: [{ path: 'SKILL.md', content }] });

describe('see changes: the installing machine’s own bytes', () => {
  it('should bound the diff: two wholly different big files come back marked, not computed forever', async () => {
    const r = rig();
    const lines = (prefix: string) => Array.from({ length: 6000 }, (_, index) => `${prefix}${index}`).join('\n');
    const first = await r.service.preview('project', await request(alice, skillV(1, lines('a')), projectTarget()));
    await r.service.apply('project', { previewId: first.previewId, secretBindings: {} }, GOVERNANCE, STEP_UP);
    const started = Date.now();
    await r.service.preview('project', await request(alice, skillV(2, lines('b')), projectTarget()));
    should(Date.now() - started).be.below(20_000);
  });
});
