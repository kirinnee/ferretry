import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DoctorReportSchema } from '../../../contract/doctor.ts';
import { bootHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { implementDaemon, definePlugin } from '../../../manifest/index.ts';
import { AdmissionPort } from '../../../contract/bound.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { recordingAdmission, request } from './fixtures.ts';

const gate = definePlugin({
  id: 'gate',
  title: 'Gate',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  provides: { admission: AdmissionPort },
});

const valid = {
  format: 1,
  id: 'pasted',
  title: 'Pasted',
  version: '1.0.0',
  api: 5,
  kinds: ['instruction'],
};

// Assembled at run time so no token-shaped literal sits in the repository.
const GITHUB_KEY = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('');
const ANTHROPIC_KEY = ['sk', '-ant-', 'abc123def456ghi789'].join('');

async function doctorWith(plugin: Record<string, unknown>): Promise<{ body: string; sentences: string; logged: string }> {
  const root = await mkdtemp(`${tmpdir()}/data-plugin-doctor-`);
  const home = `${root}/home`;
  const logged: string[] = [];
  const boot = () =>
    bootHost({
      home,
      version: '5.0.0',
      adapters: {
        ...realAdapters(home, () => {}, { binary: 'fy' }),
        clock: fixedClock(),
        homeLock: async () => ({ release: async () => {} }),
        logSink: record => logged.push(JSON.stringify(record)),
      },
      implementations: [implementDaemon(gate, { build: () => ({ provides: { admission: recordingAdmission() } }) })],
    });
  // A first boot makes the home (home.json); the data plugin is installed into it, then it boots again.
  const first = await boot();
  if (first.kind !== 'running') throw new Error(first.sentence);
  await first.host.stop();
  await mkdir(`${home}/state/kernel/plugins/pasted`, { recursive: true });
  await writeFile(`${home}/state/kernel/plugins/pasted/plugin.json`, JSON.stringify(plugin));
  const outcome = await boot();
  try {
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    const response = await outcome.host.dispatch(request('GET', '/v1/doctor'));
    expect(response.status).toBe(200);
    DoctorReportSchema.parse(JSON.parse(response.body));
    return { body: response.body, sentences: JSON.stringify(await outcome.host.doctor()), logged: logged.join('\n') };
  } finally {
    if (outcome.kind === 'running') await outcome.host.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('R-0081 n3 a data plugin.json with a ghp_ key never names it in the doctor body or sentence; the local log does', async () => {
  const result = await doctorWith({ ...valid, [GITHUB_KEY]: true });
  expect(result.body).not.toContain(GITHUB_KEY);
  expect(result.sentences).not.toContain(GITHUB_KEY);
  expect(result.body).toContain('does not check');
  expect(result.logged).toContain(GITHUB_KEY);
});

test('R-0081 n3 a data plugin.json with an sk-ant- key never names it in the doctor body or sentence', async () => {
  const result = await doctorWith({ ...valid, [ANTHROPIC_KEY]: true });
  expect(result.body).not.toContain(ANTHROPIC_KEY);
  expect(result.sentences).not.toContain(ANTHROPIC_KEY);
  expect(result.body).not.toContain('sk-ant');
});

test('R-0081 n3 a normal unknown key is still named, next to a hidden token-shaped one', async () => {
  const plain = await doctorWith({ ...valid, extra: 1 });
  expect(plain.body).toContain('Unrecognized key: \\"extra\\"');
  const both = await doctorWith({ ...valid, extra: 1, [GITHUB_KEY]: true });
  expect(both.body).toContain('extra');
  expect(both.body).not.toContain(GITHUB_KEY);
});

test('R-0081 n3 a data plugin whose id is token-shaped and not its folder is not echoed', async () => {
  const result = await doctorWith({ ...valid, id: ANTHROPIC_KEY });
  expect(result.body).not.toContain(ANTHROPIC_KEY);
  expect(result.body).toContain('which is taken or not its folder');
});
