import { describe, it } from 'bun:test';
import type { LocalModels } from '@ferretry/protocol';
import should from 'should';
import { LocalModelsService } from '../../../src/lib/local-models/service.ts';
import type { ProviderProbePlan } from '../../../src/lib/provider-probe/plan.ts';
import type { AuthorizedOutcome } from '../../../src/lib/speedups/ports.ts';

const tags = (...names: string[]): AuthorizedOutcome => ({
  kind: 'completion',
  payload: { models: names.map(name => ({ name })) },
});

function world(
  answers: AuthorizedOutcome[],
  options: { address?: string; enabled?: boolean; hold?: Promise<void>; changed?: LocalModels[] } = {},
) {
  const sent: ProviderProbePlan[] = [];
  const changed: LocalModels[] = options.changed ?? [];
  let clock = 0;
  const service: LocalModelsService = new LocalModelsService({
    probe: {
      probe: async plan => {
        sent.push(plan);
        await options.hold;
        return answers.shift() ?? { kind: 'unreachable' };
      },
    },
    address: options.address,
    enabled: options.enabled ?? true,
    suggested: async () => 'gpt-oss:20b',
    now: () => `2026-10-19T00:00:0${clock++}.000Z`,
    onChanged: async () => {
      changed.push(service.snapshot() as LocalModels);
    },
  });
  return { service, sent, changed };
}

describe('LocalModelsService', () => {
  it('should hold nothing, and read nothing, until somebody asks', () => {
    // Arrange / Act
    const { service, sent } = world([]);

    // Assert
    should(service.snapshot()).be.undefined();
    should(sent).eql([]);
  });

  it('should read /api/tags with a keyless local request, and keep the answer', async () => {
    // Arrange
    const { service, sent } = world([tags('gpt-oss:20b')]);

    // Act
    const view = await service.refresh();

    // Assert
    should(view.state).equal('found');
    should(service.snapshot()).equal(view);
    should(sent).have.length(1);
    should(sent[0]).match({
      kind: 'local',
      spends: 'nothing',
      request: { method: 'GET', url: 'http://127.0.0.1:11434/api/tags' },
    });
  });

  it('should read the address it was given', async () => {
    // Arrange
    const { service, sent } = world([tags('a:1')], { address: ':9999' });

    // Act
    await service.refresh();

    // Assert
    should(sent[0]?.request.url).equal('http://127.0.0.1:9999/api/tags');
  });

  it('should answer "not running" rather than throw when nothing is listening', async () => {
    // Arrange
    const { service } = world([{ kind: 'unreachable' }]);

    // Act
    const view = await service.refresh();

    // Assert
    should(view.state).equal('not-running');
  });

  it('should send nothing for an address off this machine, or when reading is switched off', async () => {
    // Arrange
    const away = world([tags('a:1')], { address: 'gpu-box.lan' });
    const off = world([tags('a:1')], { enabled: false });

    // Act
    const refused = await away.service.refresh();
    const disabled = await off.service.refresh();

    // Assert
    should(refused.state).equal('refused');
    should(disabled.state).equal('disabled');
    should([...away.sent, ...off.sent]).eql([]);
  });

  it('should let callers who arrive during a read share it', async () => {
    // Arrange
    let release: () => void = () => undefined;
    const hold = new Promise<void>(resolve => {
      release = resolve;
    });
    const { service, sent } = world([tags('a:1')], { hold });

    // Act
    const first = service.refresh();
    const second = service.refresh();
    release();
    const [one, two] = await Promise.all([first, second]);
    const third = await service.refresh();

    // Assert
    should(one).equal(two);
    should(sent).have.length(2);
    should(third.checkedAt).not.equal(one.checkedAt);
  });

  it('should tell the fleet only when what runtimes offer would change', async () => {
    // Arrange
    const { service, changed } = world([
      { kind: 'unreachable' },
      tags('a:1'),
      tags('a:1'),
      tags('a:1', 'b:2'),
      { kind: 'unreachable' },
      { kind: 'unreachable' },
    ]);

    // Act
    await service.refresh(); // nothing before, nothing now
    await service.refresh(); // a:1 appears
    await service.refresh(); // the same
    await service.refresh(); // b:2 appears
    await service.refresh(); // Ollama stops: the catalog's suggestions return
    await service.refresh(); // still stopped

    // Assert
    should(changed.map(view => view.state)).eql(['found', 'found', 'not-running']);
    should(changed.map(view => view.models.length)).eql([1, 2, 0]);
  });
});
