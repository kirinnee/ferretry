import { afterAll, beforeAll, describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import pkg from '../../package.json' with { type: 'json' };
import { standInDaemon, HEALTH } from '../integration/support/stand-in-daemon.ts';
import { type CliDriver, defaultCommand, ProcessCliDriver } from './driver.ts';

// `fy daemon name` as a separate process, against a stand-in daemon that keeps host.yaml the way the real one does.
const binEntry = Object.values(pkg.bin)[0] ?? 'bin/fy.ts';
const driver: CliDriver = new ProcessCliDriver(defaultCommand(binEntry, join(dirname(import.meta.path), '..', '..')));

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'fy-sit-name-'));
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

const HOSTNAME = 'pebox-hostname';

/** The plugin lines a daemon of this very build answers: the guard needs every one, with its hash, before any call. */
const generated = readFileSync(join(dirname(import.meta.path), '..', '..', 'src', 'generated', 'commands.ts'), 'utf8');
const kernelContract = /^\s*kernel: \{ manifest: \w+, contract: "([0-9a-f]+)" \}/mu.exec(generated)?.[1];
if (kernelContract === undefined) throw new Error('the generated registry has no kernel line: regenerate it');
const PLUGINS = [
  { id: 'kernel', on: true, contract: kernelContract },
  ...[...generated.matchAll(/\{ id: "([^"]+)", manifest: \w+, contract: "([0-9a-f]+)"/gu)].map(([, id, contract]) => ({
    id,
    on: true,
    contract,
  })),
];

/** A daemon that holds `host.yaml` in memory and names the machine from it, else its host name. */
function namedDaemon() {
  let text: string | undefined;
  const nameOf = (): string => {
    const owned = text === undefined ? undefined : /^name: (.*)$/mu.exec(text)?.[1];
    return owned === undefined ? HOSTNAME : (JSON.parse(owned) as string);
  };
  const daemon = standInDaemon(async (request, path) => {
    if (path === '/v1/health') return Response.json(HEALTH);
    if (path === '/v1/plugins') return Response.json({ protocol: 1, daemonName: nameOf(), plugins: PLUGINS });
    if (path === '/v1/config/file' && request.method === 'GET')
      return Response.json({
        path: 'host.yaml',
        exists: text !== undefined,
        text: text ?? '',
        etag: `e${String(text?.length ?? 0)}`,
      });
    if (path === '/v1/config/file' && request.method === 'PUT') {
      const body = (await request.json()) as { text: string };
      // The CLI writes the name as a JSON string, so a bell arrives as the six characters \u0007.
      if (body.text.includes('\\u0007'))
        return Response.json(
          {
            error: 'host.yaml has a problem',
            issues: [
              {
                path: 'host.yaml',
                severity: 'error',
                message: 'a machine name cannot hold a control or invisible character',
              },
            ],
          },
          { status: 422 },
        );
      text = body.text;
      return Response.json({ path: 'host.yaml', etag: 'e', outcome: 'applied' });
    }
    if (path === '/v1/config/file' && request.method === 'DELETE') {
      text = undefined;
      return Response.json({ path: 'host.yaml', etag: 'e', outcome: 'removed' });
    }
    return Response.json({ error: 'no' }, { status: 404 });
  });
  return daemon;
}

const env = (url: string): Record<string, string> => ({
  HOME: home,
  FY_HOME: join(home, 'fy-home'),
  FY_URL: url,
  FY_TOKEN: 'owner-token',
});

describe('fy daemon name (SIT)', () => {
  it('shows the host name and says it is the host name, until an owner name is set', async () => {
    const { url } = namedDaemon();
    const shown = await driver.run(['daemon', 'name'], env(url));
    should(shown.code).equal(0);
    should(shown.out).containEql(`name    ${HOSTNAME}`).and.containEql('source  the host name');
  });

  it('sets a name with spaces and emoji, shows it as the owner’s, and clears it back to the host name', async () => {
    const { url } = namedDaemon();
    const set = await driver.run(['daemon', 'name', 'Büro', '🦫'], env(url));
    should(set.err).equal('');
    should(set.code).equal(0);
    should(set.out).containEql('this machine is now called Büro 🦫');
    const shown = await driver.run(['daemon', 'name'], env(url));
    should(shown.out).containEql('name    Büro 🦫').and.containEql('source  set by the owner');
    const cleared = await driver.run(['daemon', 'name', '--clear'], env(url));
    should(cleared.code).equal(0);
    should(cleared.out).containEql('back to the host name');
    const after = await driver.run(['daemon', 'name'], env(url));
    should(after.out).containEql(`name    ${HOSTNAME}`).and.containEql('source  the host name');
  });

  it('prints the daemon’s own sentence and exits 1 when it refuses the name', async () => {
    const { url } = namedDaemon();
    const refused = await driver.run(['daemon', 'name', 'bell\u0007'], env(url));
    should(refused.code).equal(1);
    should(refused.err).containEql('a machine name cannot hold a control or invisible character');
  });

  it('refuses a name together with --clear', async () => {
    const { url } = namedDaemon();
    const both = await driver.run(['daemon', 'name', 'pebox', '--clear'], env(url));
    should(both.code).equal(2);
  });
});
