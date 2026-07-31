import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerAnalyticsCommands } from '../../../src/lib/analytics/commands';
import { AnalyticsController } from '../../../src/lib/analytics/controller';
import { CapturingOutput, RecordingAnalyticsGateway, aggregate, aggregateResponse } from './fixtures';

const response = aggregateResponse([aggregate()]);

function build() {
  const gateway = new RecordingAnalyticsGateway(response);
  const out = new CapturingOutput();
  return { gateway, out, controller: new AnalyticsController(gateway, out) };
}

function run(argv: string[]) {
  const { gateway, out, controller } = build();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerAnalyticsCommands(program, controller);
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('analytics controller', () => {
  it('should join the variadic query so simple queries need no quoting', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.query(['sum(tokens)', 'by', 'agent'], {});

    // Assert
    should(gateway.queries).deepEqual(['sum(tokens) by agent']);
  });

  it('should send no query at all when none was given', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.query([], {});

    // Assert — an empty string would be a different request; the daemon defaults on absence.
    should(gateway.queries).deepEqual([undefined]);
  });

  it('should treat a whitespace-only query as absent', async () => {
    // Arrange
    const { controller, gateway } = build();

    // Act
    await controller.query(['  ', ''], {});

    // Assert
    should(gateway.queries).deepEqual([undefined]);
  });

  it('should render the terminal table by default', async () => {
    // Arrange
    const { controller, out } = build();

    // Act
    await controller.query([], {});

    // Assert
    should(out.messages).have.length(1);
    should(out.messages[0]).startWith('All sessions: 40 indexed, 24 matched');
  });

  it('should emit the protocol response under --json', async () => {
    // Arrange
    const { controller, out } = build();

    // Act
    await controller.query([], { json: true });

    // Assert
    should(JSON.parse(String(out.messages[0]))).deepEqual(JSON.parse(JSON.stringify(response)));
  });

  it('should propagate a daemon failure rather than printing a table', async () => {
    // Arrange
    const out = new CapturingOutput();
    const controller = new AnalyticsController(
      { analytics: () => Promise.reject(new Error('fyd is unavailable')) },
      out,
    );

    // Act + Assert
    await should(controller.query([], {})).be.rejectedWith(/fyd is unavailable/u);
    should(out.messages).be.empty();
  });
});

describe('analytics command surface', () => {
  it('should run with no query', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['analytics']);
    await parsed;

    // Assert
    should(gateway.queries).deepEqual([undefined]);
  });

  it('should pass a quoted query through unchanged', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['analytics', 'count by day{status="failed"}']);
    await parsed;

    // Assert
    should(gateway.queries).deepEqual(['count by day{status="failed"}']);
  });

  it('should accept an unquoted multi-word query', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['analytics', 'sum(tokens)', 'by', 'agent']);
    await parsed;

    // Assert
    should(gateway.queries).deepEqual(['sum(tokens) by agent']);
  });

  it('should honour --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['analytics', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(String(out.messages[0])).kind).equal('aggregate');
  });

  it('should document the query language in its help', async () => {
    // Arrange
    let help = '';
    const program = new Command().name('fy').exitOverride();
    program.configureOutput({
      writeOut: text => {
        help += text;
      },
      writeErr: () => {},
    });
    registerAnalyticsCommands(program, build().controller);

    // Act
    await should(program.parseAsync(['node', 'fy', 'analytics', '--help'])).be.rejected();

    // Assert — the query language lives in the daemon, so the examples are the CLI's only teaching surface.
    should(help).containEql('Examples:');
    should(help).containEql('sum(tokens) by agent');
  });
});
