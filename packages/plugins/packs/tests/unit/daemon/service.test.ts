import { describe, it } from 'bun:test';
import should from 'should';
import { PackInventorySchema, PackViewSchema, type RoutingFile } from '../../../contract/index.ts';
import type { ModelCatalogView } from '../../../daemon/lib/catalog.ts';
import { type PackPorts, PackService } from '../../../daemon/lib/service.ts';
import { catalog, choice, entry, facts, packConfig, runtime } from './support.ts';

const PROMPT = 'Everyday work: opus at high; then haiku for chores.';
const GUIDE_FILE: RoutingFile = { prompt: PROMPT };

const CLAUDE_MAIN = runtime('claude-main', {
  catalogId: 'anthropic',
  choices: [
    choice('opus', 'Opus', { tier: 'best', efforts: ['low', 'high'] }),
    choice('sonnet', 'Sonnet', { tier: 'balanced' }),
  ],
});
const CLAUDE_FAST = runtime('claude-fast', {
  catalogId: 'anthropic',
  choices: [choice('haiku', 'Haiku', { tier: 'fast' })],
});

const CATALOGS: readonly ModelCatalogView[] = [
  catalog('anthropic', 'Anthropic', {
    claude: [
      entry('opus', 'Opus', 'best', { efforts: ['low', 'high'] }),
      entry('haiku', 'Haiku', 'fast'),
      entry('sonnet', 'Sonnet', 'balanced'),
    ],
    codex: [entry('gpt-5', 'GPT-5', 'best')],
  }),
];

interface Options {
  config?: ReturnType<typeof packConfig>;
  routingFile?: RoutingFile;
  runtimes?: readonly ReturnType<typeof runtime>[];
}

function build(options: Options = {}) {
  const ports: PackPorts = {
    settings: async () => ({ config: options.config ?? packConfig(), routingFile: options.routingFile ?? GUIDE_FILE }),
    catalogs: async () => CATALOGS,
    facts: async () => facts({ runtimes: options.runtimes ?? [CLAUDE_MAIN, CLAUDE_FAST] }),
    bin: 'fy',
    now: () => '2026-10-22T12:00:00.000Z',
  };
  return { subject: new PackService(ports) };
}

describe('PackService starts no helper', () => {
  it('should offer no start: fy new is Ferrets’ verb, and Packs shapes a start only through start.decide', () => {
    should(Object.getOwnPropertyNames(PackService.prototype)).not.containEql('newChild');
  });
});

describe('PackService.routingLine', () => {
  it("should give the whole routing prompt as one line, the file's or else the default", async () => {
    // Arrange
    const own = build({ routingFile: { prompt: 'Plans: opus at high.\n- Chores: "haiku"' } });
    const none = build({ routingFile: {} });

    // Act / Assert
    should(await own.subject.routingLine()).equal("Routing: Plans: opus at high. Chores: 'haiku'");
    should(await none.subject.routingLine()).startWith("Routing: Pick each sub-task's model by the kind of work: ");
    should(await none.subject.routingLine()).not.containEql('\n');
  });
});

describe('PackService.view', () => {
  it('should read the settings, the routing prompt in effect, the vocabulary and the models usable now', async () => {
    // Arrange
    const { subject } = build();

    // Act
    const view = await subject.view();

    // Assert
    should(view.config).deepEqual(packConfig());
    should(view.routing).deepEqual({ text: PROMPT, source: 'file' });
    should(view.models.map(model => model.id)).deepEqual(['opus', 'haiku', 'sonnet', 'gpt-5']);
    should(view.available.map(option => [option.model, option.named ?? null])).deepEqual([
      ['opus', 1],
      ['haiku', 2],
      ['sonnet', null],
    ]);
    should(PackViewSchema.safeParse({ ...view, cleanUp: { available: false, runtimes: [] } }).success).be.true();
  });

  it('should show the default, and say so, when the file has no prompt', async () => {
    // Act
    const view = await build({ routingFile: {} }).subject.view();

    // Assert
    should(view.routing.source).equal('default');
    should(view.routing.text).containEql('critical code: opus at high');
  });

  it('should render the default from the catalogs whatever the file says', async () => {
    should(await build().subject.defaultPrompt()).containEql('- Everyday coding: sonnet.');
  });
});

describe('PackService.inventory', () => {
  it('should show the clean-up ferret every runtime, every model and the prompt in effect, names and states only', async () => {
    // Act
    const inventory = await build().subject.inventory();

    // Assert
    should(PackInventorySchema.safeParse(inventory).success).be.true();
    should(inventory.at).equal('2026-10-22T12:00:00.000Z');
    should(inventory.runtimes.map(row => [row.name, row.login, row.ready, row.models])).deepEqual([
      ['claude-main', 'claude-main-login', true, ['opus', 'sonnet']],
      ['claude-fast', 'claude-fast-login', true, ['haiku']],
    ]);
    should(inventory.models.find(model => model.id === 'opus')?.runtimes).deepEqual([
      { name: 'claude-main', ready: true },
    ]);
    should(inventory.routing.text).equal(PROMPT);
  });
});

describe('PackService.recommend', () => {
  it('should answer the routing prompt, the models usable now and what --auto would try first', async () => {
    // Act
    const answer = await build().subject.recommend({ task: 'fix the bug' });

    // Assert
    should(answer.task).equal('fix the bug');
    should(answer.routing.text).equal(PROMPT);
    should(answer.available).have.length(3);
    should(answer.next).equal(
      'fy new --runtime claude-main --model opus --effort high --name "<short task title>" "<complete brief>"',
    );
  });

  it('should answer without a task, and with no next when nothing can run', async () => {
    // Act
    const answer = await build({ runtimes: [] }).subject.recommend({});

    // Assert
    should(answer).not.have.property('task');
    should(answer).not.have.property('next');
    should(answer.available).be.empty();
  });
});
