/**
 * Reading the models Ollama has installed (docs/model-catalog.md § Local models), end to end across the
 * real keyless probe and the real HTTP transport — against a FAKE Ollama server on a loopback port the
 * test owns. CI never touches the network or a real Ollama.
 */
import { afterEach, describe, it } from 'bun:test';
import { builtInModelCatalogs, builtInPresets, loginModelCatalog, runtimeModels } from '@ferretry/fleet';
import should from 'should';
import { AuthorizedProviderProbe } from '../../../src/adapters/provider-probe/authorized-provider-probe.ts';
import { FetchEnhancementTransport } from '../../../src/adapters/stt/fetch-enhancement-transport.ts';
import { LocalModelsService } from '../../../src/lib/index.ts';
import { ScriptedAuthorizer } from '../../unit/speedups/fakes.ts';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly cookie: string | null;
}

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** A fake Ollama: answers `/api/tags` with whatever the test says, and records who asked. */
function fakeOllama(answer: () => Response) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        cookie: request.headers.get('cookie'),
      });
      return answer();
    },
  });
  servers.push(server);
  return { seen, address: `127.0.0.1:${server.port}` };
}

const read = (address: string | undefined, enabled = true) => {
  const service: LocalModelsService = new LocalModelsService({
    probe: new AuthorizedProviderProbe(new ScriptedAuthorizer({ kind: 'refused' }), new FetchEnhancementTransport()),
    address,
    enabled,
    suggested: async () => 'gpt-oss:20b',
    now: () => '2026-10-19T00:00:00.000Z',
  });
  return { service };
};

const tagsReply = (...names: string[]) =>
  Response.json({
    models: names.map(name => ({
      name,
      model: name,
      modified_at: '2026-10-18T10:12:42.123456789-07:00',
      size: 1_000,
      details: { family: 'llama', parameter_size: '3B', quantization_level: 'Q4_K_M' },
    })),
  });

describe('reading Ollama on this machine', () => {
  it('should list the installed models with one credential-free GET, and turn them into the runtime’s model set', async () => {
    // Arrange
    const ollama = fakeOllama(() => tagsReply('llama3.2:latest', 'gpt-oss:120b'));
    const { service } = read(ollama.address);

    // Act
    const view = await service.refresh();
    const derived = runtimeModels({
      harness: 'codex',
      modelSet: undefined,
      ...loginModelCatalog({ store: 'environment', preset: 'ollama-codex' }, 'codex', {
        catalogs: builtInModelCatalogs(),
        presets: builtInPresets(),
        local: { ollama: view },
      }),
    });

    // Assert
    should(ollama.seen).eql([{ method: 'GET', path: '/api/tags', authorization: null, cookie: null }]);
    should(view.state).equal('found');
    should(view.models.map(model => model.id)).eql(['llama3.2:latest', 'gpt-oss:120b']);
    should(derived.models.map(model => [model.id, model.local])).eql([
      ['gpt-oss:120b', true],
      ['llama3.2:latest', true],
    ]);
  });

  it('should say no model is installed, with the command that installs one', async () => {
    // Arrange
    const { service } = read(fakeOllama(() => tagsReply()).address);

    // Act
    const view = await service.refresh();

    // Assert
    should(view).match({ state: 'none-pulled', models: [], pullCommand: 'ollama pull gpt-oss:20b' });
  });

  it('should say Ollama is not running when nothing listens — never throw', async () => {
    // Arrange — a port that was just released
    const stopped = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const address = `127.0.0.1:${stopped.port}`;
    stopped.stop(true);
    const { service } = read(address);

    // Act
    const view = await service.refresh();

    // Assert
    should(view.state).equal('not-running');
    should(view.message).containEql('ollama serve');
  });

  it('should say a server that is not Ollama is not readable', async () => {
    for (const answer of [
      () => Response.json({ hello: 'world' }),
      () => new Response('<html>nginx</html>', { headers: { 'content-type': 'text/html' } }),
      () => new Response('nope', { status: 500 }),
      () => new Response('', { status: 404 }),
    ]) {
      // Arrange
      const { service } = read(fakeOllama(answer).address);

      // Act / Assert
      should((await service.refresh()).state).equal('unreadable');
    }
  });

  it('should never dial an address that is not this machine, or any address when reading is off', async () => {
    // Arrange — the fake stands in for "some other host"; the address names a documentation range
    const ollama = fakeOllama(() => tagsReply('a:1'));
    const away = read('203.0.113.7:11434');
    const off = read(ollama.address, false);

    // Act
    const refused = await away.service.refresh();
    const disabled = await off.service.refresh();

    // Assert
    should(refused.state).equal('refused');
    should(disabled.state).equal('disabled');
    should(ollama.seen).eql([]);
  });

  it('should reflect a model pulled after the first read on the next one, and not before', async () => {
    // Arrange
    let names = ['llama3.2:latest'];
    const ollama = fakeOllama(() => tagsReply(...names));
    const { service } = read(ollama.address);

    // Act
    const first = await service.refresh();
    names = ['llama3.2:latest', 'qwen3:8b'];
    const held = service.snapshot();
    const second = await service.refresh();

    // Assert
    should(first.models).have.length(1);
    should(held).equal(first);
    should(second.models.map(model => model.id)).eql(['llama3.2:latest', 'qwen3:8b']);
    should(ollama.seen).have.length(2);
  });
});
