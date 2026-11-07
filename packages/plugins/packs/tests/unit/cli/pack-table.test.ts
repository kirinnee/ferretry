import { describe, it } from 'bun:test';
import should from 'should';
import { at } from './fixtures.ts';
import { type PackRow, type PackTable, PackTableSchema } from '../../../contract/index.ts';
import {
  type ICellColour,
  PackCommandError,
  PackTableController,
  renderPackTable,
  sinceLabel,
} from '../../../cli/lib/pack-table.ts';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const markerColour: ICellColour = { amber: cell => `<amber>${cell}</amber>` };

const row = (overrides: Partial<PackRow> & Pick<PackRow, 'id' | 'name'>): PackRow => ({
  depth: 1,
  model: 'sonnet',
  state: 'running',
  ferretState: 'working',
  ...overrides,
});

const table = (rows: PackRow[]): PackTable => ({
  root: { id: 'ses-lead', name: 'rhett' },
  at: at('2026-11-03T12:00:00.000Z'),
  endedWindowMs: 7_200_000,
  rows,
});

describe('sinceLabel', () => {
  it('should say now under a minute and the coarsest whole unit after', () => {
    should(sinceLabel(NOW, at('2026-11-03T11:59:30.000Z'))).equal('now');
    should(sinceLabel(NOW, at('2026-11-03T11:55:00.000Z'))).equal('5m');
    should(sinceLabel(NOW, at('2026-11-03T09:00:00.000Z'))).equal('3h');
    should(sinceLabel(NOW, at('2026-11-01T12:00:00.000Z'))).equal('2d');
  });

  it('should say now for an instant it cannot read', () => {
    should(sinceLabel(NOW, 'garbage')).equal('now');
  });
});

describe('renderPackTable', () => {
  it('should render a header and one aligned line per row, indenting by depth', () => {
    // Arrange
    const subject = table([
      row({
        id: 'a',
        name: 'ada',
        card: { ref: '&F7', lane: 'Implement' },
        last: { at: at('2026-11-03T11:58:00.000Z'), source: 'note', text: 'wiring the route' },
      }),
      row({ id: 'b', name: 'bo', depth: 2, model: 'glm-5.3' }),
    ]);

    // Act
    const lines = renderPackTable(subject, NOW, markerColour);

    // Assert
    should(lines[0]).equal('rhett (ses-lead): 2 helpers');
    should(lines[1]).match(/^FERRET\s+MODEL\s+STATE\s+CARD\s+LAST$/);
    should(lines[2]).match(/^ada\s+sonnet\s+running\s+&F7 Implement\s+\[2m\] wiring the route$/);
    should(lines[3]).match(/^ {2}bo\s+glm-5\.3\s+running\s+-\s+-$/);
  });

  it('should mark an ended row with how long ago it ended', () => {
    const lines = renderPackTable(
      table([
        row({ id: 'a', name: 'ada', state: 'ended', ferretState: 'stopped', endedAt: at('2026-11-03T11:50:00.000Z') }),
      ]),
      NOW,
      markerColour,
    );

    should(lines[2]).match(/ended 10m/);
  });

  it('should paint only the state cell of a row that needs the owner', () => {
    const lines = renderPackTable(
      table([row({ id: 'a', name: 'ada', state: 'needs-you' }), row({ id: 'b', name: 'bo' })]),
      NOW,
      markerColour,
    );

    should(lines[2]).match(/<amber>needs-you<\/amber>/);
    should(lines[3]).not.match(/amber/);
  });

  it('should say so, and name the ended window, when there are no helpers', () => {
    should(renderPackTable(table([]), NOW, markerColour)).deepEqual([
      'rhett (ses-lead): 0 helpers; ended ones show for 120m',
    ]);
  });

  it('should use the singular for one helper', () => {
    should(renderPackTable(table([row({ id: 'a', name: 'ada' })]), NOW, markerColour)[0]).match(/1 helper$/);
  });
});

describe('PackTableSchema (the --json shape)', () => {
  it('should accept the rows the table is built from and refuse an unknown field', () => {
    const subject = table([
      row({ id: 'a', name: 'ada', last: { at: at('2026-11-03T11:58:00.000Z'), source: 'message', text: 'done' } }),
    ]);

    should(PackTableSchema.parse(subject)).deepEqual(subject);
    should(PackTableSchema.safeParse({ ...subject, extra: 1 }).success).be.false();
  });

  it('should refuse a last line over 100 characters', () => {
    const long = table([
      row({
        id: 'a',
        name: 'ada',
        last: { at: at('2026-11-03T11:58:00.000Z'), source: 'note', text: 'x'.repeat(101) },
      }),
    ]);

    should(PackTableSchema.safeParse(long).success).be.false();
  });
});

describe('PackTableController', () => {
  const build = (caller: string | undefined) => {
    const asked: string[] = [];
    const lines: string[] = [];
    const controller = new PackTableController(
      {
        table: async id => {
          asked.push(id);
          return table([row({ id: 'a', name: 'ada' })]);
        },
      },
      { success: message => void lines.push(message) },
      caller,
      () => NOW,
      markerColour,
    );
    return { controller, asked, lines };
  };

  it('should default to the calling ferret and print the table', async () => {
    // Arrange
    const { controller, asked, lines } = build('ses-lead');

    // Act
    await controller.execute(undefined);

    // Assert
    should(asked).eql(['ses-lead']);
    should(lines[0]).equal('rhett (ses-lead): 1 helper');
  });

  it('should take a named ferret over the caller, and print JSON when asked', async () => {
    // Arrange
    const { controller, asked, lines } = build('ses-lead');

    // Act
    await controller.execute(' other ', { json: true });

    // Assert
    should(asked).eql(['other']);
    should(JSON.parse(lines[0] ?? '').root).eql({ id: 'ses-lead', name: 'rhett' });
  });

  it('should refuse, as a usage error, outside a ferret with no id', async () => {
    // Arrange
    const { controller } = build(undefined);

    // Act
    const failure = await controller.execute(undefined).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(failure).be.instanceOf(PackCommandError);
    should((failure as PackCommandError).exitCode).equal(2);
  });
});
