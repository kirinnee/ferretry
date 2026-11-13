import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type PluginClient } from '@ferretry/kernel/manifest';
import { ferret, owner, type TestHost, testHost, testPluginClient } from '@ferretry/kernel/testing';
import should from 'should';
import { parseArgs } from '../../support/shell-argv.ts';
import { BrowserClient } from '../../../cli/lib/client.ts';
import { BrowserDispatcher } from '../../../cli/lib/dispatcher.ts';
import { verbTable } from '../../../cli/lib/verbs/index.ts';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';

/**
 * THE `fy browser` VERBS, END TO END ON A REAL BROWSER.
 *
 * Everything below the verb is production: the verb table and dispatcher, the plugin client, the kernel's route spine
 * and tool door in the test host, the daemon half (routes, tool handlers, the agent browser service), the browser
 * worker over CDP, and a real headless Chrome the harness starts on random loopback ports. Two roads reach it, as in
 * life: a PERSON names a ferret (`--ferret f1`, the declared routes), and the FERRET itself calls its own tools.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const SENTINEL = 'sentinel-Pa55w0rd-7f3a9c';

const ALL_ON: AgentControlReader = { allows: async () => true };
const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: 'f1' } : undefined) };

let root = '';
let site: ReturnType<typeof Bun.serve>;
let base = '';
let host: TestHost;
const calling = 'f1' as FerretId;

interface Terminal {
  readonly out: string[];
  readonly err: string[];
  readonly files: Map<string, Uint8Array>;
  run(line: string): Promise<number>;
}

/** The verbs as `fy` composes them, over the test host: a person's (owner) or the ferret f1's own. */
function typing(as: 'person' | 'ferret', stdin = ''): Terminal {
  const out: string[] = [];
  const err: string[] = [];
  const files = new Map<string, Uint8Array>();
  const caller = as === 'person' ? owner() : ferret('f1');
  const client: PluginClient = {
    ...testPluginClient(host, caller),
    tool: async (name, input) => await host.tool(name, input, { as: caller }),
  } as PluginClient;
  const table = verbTable({ script: '', unit: '', verifyUnit: '', timer: '' });
  const dispatcher = new BrowserDispatcher(
    table,
    new BrowserClient(client),
    { out: text => void out.push(text), err: text => void err.push(text), isTty: false },
    {
      ownFerret: as === 'ferret' ? 'f1' : undefined,
      readStdin: async () => stdin,
      writeFile: async (path, bytes) => void files.set(path, bytes),
    },
  );
  return {
    out,
    err,
    files,
    async run(line) {
      const words = line.split(' ');
      const firstFlag = words.findIndex(word => word.startsWith('-'));
      const leading = firstFlag === -1 ? words : words.slice(0, firstFlag);
      for (let length = leading.length; length > 0; length -= 1) {
        const verb = leading.slice(0, length).join(' ');
        if (verb in table) return await dispatcher.run(verb, parseArgs(words.slice(length)));
      }
      throw new Error(`no verb in: ${line}`);
    },
  };
}

beforeAll(async () => {
  if (chrome === null) throw new Error('this test needs a real Chrome on PATH');
  root = await mkdtemp(join(tmpdir(), 'ferretry-browser-verbs-'));
  site = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        '<html><head><title>Form</title></head><body><h1>Sign in form</h1>' +
          '<input id="name" aria-label="Name">' +
          "<button id=\"go\" onclick=\"document.getElementById('out').textContent='clicked:'+document.getElementById('name').value\">Go</button>" +
          '<p id="out">idle</p></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  });
  base = `http://127.0.0.1:${String(site.port)}`;
  const workers = REAL_WORKER();
  const launcher = new NodeSessionBrowserLauncher(
    new BrowserProfileStore(root),
    workers.start,
    launcherPorts(),
    { FY_CHROME_BIN: chrome, PATH: process.env.PATH, HOME: process.env.HOME },
    undefined,
    { stageDirectory: join(root, 'stage'), listenerProver: unprovenListenerProver() },
  );
  const half = implementDaemon(daemon.manifest, { build: ctx => buildBrowsers(ctx, { launcher }) });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
  );
  host = await testHost({
    plugins: [half],
    uses: { ferrets: FERRETS, agentControl: ALL_ON },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
    secrets: [],
  });
}, 90_000);

afterAll(async () => {
  await host?.stop();
  site?.stop(true);
  if (root !== '') await rm(root, { recursive: true, force: true });
}, 60_000);

describe('fy browser page …, a person acting on ferret f1', () => {
  it('should open a named page, read it, type into it, click and read what the click did', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const opened = await person.run(`browser page open app ${base}/ --ferret f1`);
    const read = await person.run('browser page read app --ferret f1');
    const typed = await person.run('browser page type app #name Ada --ferret f1');
    const clicked = await person.run('browser page click app #go --ferret f1');
    const result = await person.run('browser page read app --selector #out --ferret f1');

    // Assert
    should([opened, read, typed, clicked, result]).deepEqual([0, 0, 0, 0, 0]);
    should(person.out[0]).containEql('%browser:app');
    should(person.out[1]).containEql('Sign in form');
    should(person.out[2]).containEql('Done on %browser:app');
    should(person.out[4]).containEql('clicked:Ada');
    should(person.err.join('')).equal('');
  });

  it('should write a screenshot to the file the person named', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const code = await person.run('browser page screenshot app shot.png --ferret f1');

    // Assert
    should(code).equal(0);
    should(person.out.join('')).containEql('screenshot written to shot.png');
    const bytes = person.files.get('shot.png') ?? new Uint8Array();
    should([...bytes.slice(0, 4)]).deepEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('should list the pages and their tabs', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const listed = await person.run('browser page list --ferret f1');
    const tabs = await person.run('browser page tabs --ferret f1');

    // Assert
    should([listed, tabs]).deepEqual([0, 0]);
    should(person.out.join('')).containEql('app');
  });

  it('should type text read from standard input and never print it, while the page receives it', async () => {
    // Arrange
    const typist = typing('person', `${SENTINEL}\n`);
    const reader = typing('person');

    // Act
    const typed = await typist.run('browser page type app #name --stdin --ferret f1');
    await reader.run('browser page click app #go --ferret f1');
    const shown = await reader.run('browser page read app --selector #out --ferret f1');

    // Assert
    should([typed, shown]).deepEqual([0, 0]);
    should(typist.out.join('') + typist.err.join('')).not.containEql(SENTINEL);
    should(reader.out.join('')).containEql(`clicked:${SENTINEL}`);
  });

  it('should exit 1 when a wait never matches', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const code = await person.run('browser page wait app --text this-text-is-never-there --timeout 800 --ferret f1');

    // Assert
    should(code).equal(1);
  });

  it('should exit 0 when a wait matches', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const code = await person.run('browser page wait app --text Sign --timeout 5000 --ferret f1');

    // Assert
    should(code).equal(0);
  });
});

describe('a takeover', () => {
  it('should make the ferret’s own verbs fail with the taken-over sentence and a non-zero exit, until it is handed back', async () => {
    // Arrange
    const person = typing('person');
    const agent = typing('ferret');
    // A page a person opened is the ferret's only once the person hands it over.
    const handed = await person.run('browser page handover app --ferret f1');
    const before = await agent.run('browser page click app #go');

    // Act
    const taken = await person.run('browser page takeover app --ferret f1');
    const refused = await agent.run('browser page click app #go');
    const shown = await person.run('browser page control --ferret f1');
    const back = await person.run('browser page handback app --ferret f1');
    const after = await agent.run('browser page click app #go');

    // Assert
    should([handed, before, taken, back, after]).deepEqual([0, 0, 0, 0, 0]);
    should(refused).equal(1);
    should(agent.err.join('')).match(/taken over/iu);
    should(shown).equal(0);
    should(person.out.join('')).containEql('taken over by');
  });
});

describe('fy browser <verb>, on the whole ferret browser', () => {
  it('should show the status and navigate the shared browser of f1', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const status = await person.run('browser status --ferret f1');
    const navigated = await person.run(`browser navigate ${base}/second --ferret f1`);
    const text = await person.run('browser read h1 --ferret f1');

    // Assert
    should([status, navigated, text]).deepEqual([0, 0, 0]);
    should(person.out[0]).containEql('browser running');
    should(person.out[2]).containEql('Sign in form');
  });

  it('should stop the browser', async () => {
    // Arrange
    const person = typing('person');

    // Act
    const code = await person.run('browser stop --ferret f1');

    // Assert
    should(code).equal(0);
  });
});
