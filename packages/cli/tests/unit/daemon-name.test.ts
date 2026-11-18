/**
 * `fy daemon name [<name>|--clear]`, through the shell's REAL verb table over a fake daemon that answers the kernel's
 * `host.yaml` routes and its plugin list. The SIT (`tests/sit/daemon-name.sit.test.ts`) proves it as a process; this
 * proves every branch in the unit tier. No real home, no network.
 */
import { describe, it } from 'bun:test';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { registry } from '../../src/generated/commands.ts';
import { createPluginHost } from '../../src/adapters/plugin-host.ts';
import type { DaemonReply, SendOptions } from '../../src/lib/client.ts';
import type { DaemonRequest } from '../../src/lib/request.ts';
import { runFy } from '../../src/lib/run.ts';
import { fakeWorld, RecordingTransport } from './fakes.ts';

class RoutedTransport extends RecordingTransport {
  constructor(private readonly answers: Record<string, DaemonReply>) {
    super();
  }
  override async send(request: DaemonRequest, options?: SendOptions): Promise<DaemonReply> {
    this.sent.push(request);
    this.options.push(options);
    return (
      this.answers[`${request.method} ${request.path.split('?')[0] as string}`] ?? {
        status: 404,
        body: { error: 'nothing here' },
      }
    );
  }
}

const world = (answers: Record<string, DaemonReply>) => {
  const transport = new RoutedTransport(answers);
  const host = createPluginHost({
    home: '/fake-home',
    fs: state.createMemoryHostFs(),
    cwd: () => '/fake-cwd',
    readFile: async path => {
      throw new Error(`no such file ${path}`);
    },
    readStdin: async () => '',
    readBytes: async () => new Uint8Array(),
    readStdinBytes: async () => new Uint8Array(),
    pathExists: async () => false,
  });
  const made = fakeWorld({
    registry,
    inventory: {
      protocol: 'x' as never,
      plugins: [
        { id: 'kernel', on: true, contract: registry.kernel.contract },
        ...registry.plugins.map(plugin => ({ id: plugin.id, on: true, contract: plugin.contract })),
      ],
    },
    transport,
    host,
  });
  return { ...made, transport };
};

const PLUGINS = (name: string | undefined): DaemonReply => ({
  status: 200,
  body: name === undefined ? { plugins: [] } : { daemonName: name, plugins: [] },
});
const FILE = (text: string | undefined): DaemonReply => ({
  status: 200,
  body: { path: 'host.yaml', exists: text !== undefined, text: text ?? '', etag: 'e1' },
});
const OK: DaemonReply = { status: 200, body: {} };

describe('fy daemon name', () => {
  it('says the host name and where it comes from while the owner has set none', async () => {
    const { world: w, io } = world({ 'GET /v1/config/file': FILE(undefined), 'GET /v1/plugins': PLUGINS('pebox') });
    should(await runFy(['daemon', 'name'], w)).equal(0);
    should(io.stdout()).containEql('name    pebox').and.containEql('source  the host name');
  });

  it('says it is the owner’s when host.yaml holds a name, and that an older daemon has none to tell', async () => {
    const owned = world({ 'GET /v1/config/file': FILE('name: "Studio"\n'), 'GET /v1/plugins': PLUGINS('Studio') });
    should(await runFy(['daemon', 'name'], owned.world)).equal(0);
    should(owned.io.stdout()).containEql('name    Studio').and.containEql('source  set by the owner');
    const older = world({ 'GET /v1/config/file': FILE(undefined), 'GET /v1/plugins': PLUGINS(undefined) });
    should(await runFy(['daemon', 'name'], older.world)).equal(0);
    should(older.io.stdout()).containEql('(unknown: this daemon is older than the machine name)');
  });

  it('writes the name as one YAML scalar under the file’s etag and says what the machine is now called', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/file': FILE(undefined),
      'GET /v1/plugins': PLUGINS('pebox'),
      'PUT /v1/config/file': OK,
    });
    should(await runFy(['daemon', 'name', 'Büro', '🦫'], w)).equal(0);
    should(io.stdout()).containEql('this machine is now called Büro 🦫');
    const put = transport.sent.find(request => request.method === 'PUT');
    should(put?.body).eql({ path: 'host.yaml', text: 'name: "Büro 🦫"\n', etag: 'e1' });
  });

  it('deletes the file on --clear when the owner set a name, and says so', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/file': FILE('name: "Studio"\n'),
      'GET /v1/plugins': PLUGINS('Studio'),
      'DELETE /v1/config/file': OK,
    });
    should(await runFy(['daemon', 'name', '--clear'], w)).equal(0);
    should(io.stdout()).containEql('back to the host name');
    should(transport.sent.some(request => request.method === 'DELETE')).equal(true);
  });

  it('changes nothing on --clear when the host name is already in use', async () => {
    const {
      world: w,
      io,
      transport,
    } = world({
      'GET /v1/config/file': FILE(undefined),
      'GET /v1/plugins': PLUGINS('pebox'),
    });
    should(await runFy(['daemon', 'name', '--clear'], w)).equal(0);
    should(io.stdout()).containEql('already using the host name: pebox');
    should(transport.sent.some(request => request.method === 'DELETE')).equal(false);
  });

  it('says the host name is in use even when an older daemon did not tell it', async () => {
    const { world: w, io } = world({ 'GET /v1/config/file': FILE(undefined), 'GET /v1/plugins': PLUGINS(undefined) });
    should(await runFy(['daemon', 'name', '--clear'], w)).equal(0);
    should(io.stdout()).containEql('already using the host name: \n');
  });

  it('refuses a name together with --clear, and sends nothing', async () => {
    const { world: w, io, transport } = world({});
    should(await runFy(['daemon', 'name', 'pebox', '--clear'], w)).equal(2);
    should(io.stderr()).containEql('give a name or --clear, not both');
    should(transport.sent).eql([]);
  });

  it('prints the daemon’s own sentences and exits 1 when it will not take the name', async () => {
    const { world: w, io } = world({
      'GET /v1/config/file': FILE(undefined),
      'GET /v1/plugins': PLUGINS('pebox'),
      'PUT /v1/config/file': {
        status: 422,
        body: { error: 'invalid', issues: [{ message: 'a machine name cannot hold a control character' }] },
      },
    });
    should(await runFy(['daemon', 'name', 'bell'], w)).equal(1);
    should(io.stderr()).containEql('a machine name cannot hold a control character').and.containEql('invalid');
  });

  it('does not swallow a failure that is not a refusal of the name', async () => {
    const { world: w, io } = world({
      'GET /v1/config/file': FILE(undefined),
      'GET /v1/plugins': PLUGINS('pebox'),
      'PUT /v1/config/file': { status: 500, body: { error: 'boom' } },
    });
    should(await runFy(['daemon', 'name', 'studio'], w)).not.equal(0);
    should(io.stdout()).not.containEql('this machine is now called');
    should(io.stderr()).not.equal('');
  });
});
