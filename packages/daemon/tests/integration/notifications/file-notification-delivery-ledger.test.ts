import { afterAll, describe, it } from 'bun:test';
import { stat } from 'node:fs/promises';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { FileNotificationDeliveryLedger } from '../../../src/adapters/notifications/index.ts';
import {
  createFoundationPaths,
  type NotificationRecord,
  NotificationRecordSchema,
  resolveStateHome,
} from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const AT = '2026-08-06T11:00:00.000Z';

function requested(key = 'direct:req-1', sessionId = 'session-1'): NotificationRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'requested',
    key,
    at: AT,
    origin: 'direct',
    attribution: 'admin-cli',
    sessionId,
    request: { body: 'Release ready.', title: null, kind: null },
    sent: { kind: 'question', interactive: true, title: 'Release agent', body: 'Release ready.' },
    enrolled: 1,
  });
}

function outcome(key = 'direct:req-1'): NotificationRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'outcome',
    key,
    at: AT,
    delivered: 1,
    failed: 0,
  });
}

function agendaRequested(): NotificationRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'requested',
    key: 'attention:session-1:A1',
    at: AT,
    origin: 'attention',
    attribution: 'attention:agent:session-1',
    sessionId: 'session-1',
    agendaId: 'A1',
    sent: {
      kind: 'attention',
      interactive: false,
      title: 'Choose a region',
      body: 'The rollout needs a human decision.',
    },
    enrolled: 2,
  });
}

async function fixture(label: string) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  const warnings: string[] = [];
  return {
    paths,
    files,
    warnings,
    ledger: new FileNotificationDeliveryLedger(paths, files, { warn: message => warnings.push(message) }),
  };
}

async function writeLines(
  world: Awaited<ReturnType<typeof fixture>>,
  lines: readonly (string | Record<string, unknown>)[],
): Promise<void> {
  await world.files.ensureDirectory(world.paths.state, 0o700);
  await Bun.write(
    world.ledger.path,
    `${lines.map(line => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n')}\n`,
  );
}

afterAll(async () => {
  await cleanupTempDirectories();
});

function agendaBuzz(key: string, extra: Record<string, unknown>): NotificationRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'requested',
    key,
    at: AT,
    origin: 'attention',
    attribution: 'attention:agent:session-1',
    sessionId: 'session-1',
    agendaId: 'A1',
    sent: { kind: 'attention', interactive: false, title: 'Ada is stopped · 2 need you', body: 'Choose a region' },
    enrolled: 1,
    ...extra,
  });
}

describe('FileNotificationDeliveryLedger', () => {
  it('should keep one record per stop, per deadline and per ping, each found by its own key', async () => {
    // Arrange
    const world = await fixture('notification-ledger-buzz');
    const stop = 'attention:session-1:stopped:2026-10-23T09:00:00.000Z';

    // Act
    await world.ledger.append(agendaBuzz(stop, { stoppedAt: '2026-10-23T09:00:00.000Z' }));
    await world.ledger.append(agendaBuzz('attention:session-1:A1:deadline', { deadline: true }));
    await world.ledger.append(agendaBuzz('attention:session-1:A1:ping', { ping: true }));

    // Assert
    should((await world.ledger.find(stop))?.requested).containDeep({ stoppedAt: '2026-10-23T09:00:00.000Z' });
    should((await world.ledger.find('attention:session-1:A1:deadline'))?.requested).containDeep({ deadline: true });
    should((await world.ledger.find('attention:session-1:A1:ping'))?.requested).containDeep({ ping: true });
    should(await world.ledger.find('attention:session-1:A1')).be.undefined();
  });

  it('should read a ledger a daemon wrote before the agenda rename, and keep appending to it', async () => {
    // Arrange: the lines exactly as a v4.115.0 daemon wrote them, the item named `attentionId`.
    const world = await fixture('notification-ledger-pre-rename');
    const sent = {
      kind: 'attention',
      interactive: true,
      title: 'Ada is stopped · 2 need you',
      body: 'Choose a region',
    };
    const stop = 'agenda:session-1:stopped:2026-10-30T05:07:08.738Z';
    await writeLines(world, [
      {
        v: 1,
        phase: 'requested',
        key: 'attention:session-1:A1',
        at: AT,
        origin: 'attention',
        attribution: 'attention:human',
        sessionId: 'session-1',
        attentionId: 'A1',
        sent,
        enrolled: 1,
      },
      { v: 1, phase: 'outcome', key: 'attention:session-1:A1', at: AT, delivered: 1, failed: 0 },
      {
        v: 1,
        phase: 'requested',
        key: stop,
        at: AT,
        origin: 'agenda',
        attribution: 'attention:agent:session-1',
        sessionId: 'session-1',
        attentionId: 'A46',
        stoppedAt: '2026-10-30T05:07:08.738Z',
        sent,
        enrolled: 1,
      },
      { v: 1, phase: 'outcome', key: stop, at: AT, delivered: 1, failed: 0 },
    ]);

    // Act
    const old = await world.ledger.find('attention:session-1:A1');
    const stopped = await world.ledger.find(stop);
    await world.ledger.append(agendaBuzz('agenda:session-1:A1:ping', { origin: 'agenda', ping: true }));
    const appended = await world.ledger.find('agenda:session-1:A1:ping');

    // Assert
    should(old?.requested).containDeep({ agendaId: 'A1' });
    should(old?.outcome).containDeep({ delivered: 1 });
    should(stopped?.requested).containDeep({ agendaId: 'A46', stoppedAt: '2026-10-30T05:07:08.738Z' });
    should(appended?.requested).containDeep({ agendaId: 'A1', ping: true });
    const written = (await Bun.file(world.ledger.path).text()).trimEnd().split('\n').at(-1) ?? '';
    should(JSON.parse(written)).have.property('agendaId', 'A1').and.not.have.property('attentionId');
  });

  it('should refuse a record that names its item in both spellings', () => {
    // Act + Assert
    should(() =>
      NotificationRecordSchema.parse({
        ...agendaBuzz('attention:session-1:A1:ping', { ping: true }),
        attentionId: 'A1',
      }),
    ).throw();
  });

  it('should refuse a record whose key does not name what it is for', () => {
    // Act + Assert
    should(() => agendaBuzz('attention:session-1:A1:ping', { deadline: true })).throw();
    should(() => agendaBuzz('attention:session-1:stopped:other', { stoppedAt: '2026-10-23T09:00:00.000Z' })).throw();
  });

  it('should append requested and outcome as individual lines and merge them on lookup', async () => {
    // Arrange
    const world = await fixture('notification-ledger-roundtrip');

    // Act
    await world.ledger.append(requested());
    await world.ledger.append(outcome());
    const found = await world.ledger.find('direct:req-1');
    const text = await world.files.readText(world.ledger.path);

    // Assert
    should(text?.trim().split('\n')).have.length(2);
    should(found).containDeep({
      requested: { phase: 'requested', request: { body: 'Release ready.' } },
      outcome: { phase: 'outcome', delivered: 1, failed: 0 },
    });
  });

  it('should create a missing state directory and owner-only ledger on first append', async () => {
    // Arrange
    const world = await fixture('notification-ledger-create');

    // Act
    await world.ledger.append(requested());
    const information = await stat(world.ledger.path);

    // Assert
    should(information.mode & 0o777).equal(0o600);
  });

  it('should return undefined for a missing file and an unknown key', async () => {
    // Arrange
    const world = await fixture('notification-ledger-unknown');

    // Act
    const missing = await world.ledger.find('direct:missing');
    await world.ledger.append(requested());
    const unknown = await world.ledger.find('direct:other');

    // Assert
    should(missing).be.undefined();
    should(unknown).be.undefined();
  });

  it('should ignore only an unterminated final fragment', async () => {
    // Arrange
    const world = await fixture('notification-ledger-torn');
    await world.ledger.append(requested());
    await Bun.write(world.ledger.path, `${JSON.stringify(requested())}\n{"v":1,"phase":"outcome"`);

    // Act
    const found = await world.ledger.find('direct:req-1');

    // Assert
    should(found).containDeep({ requested: { phase: 'requested' } });
    should(found?.outcome).be.undefined();
  });

  it('should treat a wholly unterminated file as a torn fragment with no record', async () => {
    // Arrange
    const world = await fixture('notification-ledger-wholly-torn');
    await world.files.ensureDirectory(world.paths.state, 0o700);
    await Bun.write(world.ledger.path, JSON.stringify(requested()));

    // Act + Assert
    should(await world.ledger.find('direct:req-1')).be.undefined();
  });

  it('should skip and count every malformed or out-of-phase line, and still read every other', async () => {
    // Arrange
    const validRequest = requested() as Record<string, unknown>;
    const validOutcome = outcome() as Record<string, unknown>;
    const cases: readonly {
      readonly lines: readonly (string | Record<string, unknown>)[];
      readonly delivered: boolean;
      readonly reason: string;
    }[] = [
      { lines: ['not json', validRequest], delivered: false, reason: 'line 1, malformed JSON' },
      { lines: [validRequest, 'not json'], delivered: false, reason: 'line 2, malformed JSON' },
      { lines: [validRequest, validRequest], delivered: false, reason: 'line 2, a second request' },
      { lines: [validRequest, validOutcome, validOutcome], delivered: true, reason: 'line 3, a second outcome' },
      { lines: [validOutcome, validRequest], delivered: false, reason: 'line 1, an outcome before its request' },
      { lines: [{ ...validRequest, v: 2 }, validRequest], delivered: false, reason: 'line 1, not a phase record' },
      { lines: [{ ...validRequest, phase: 'settled' }, validRequest], delivered: false, reason: 'line 1, not a phase' },
    ];

    // Act + Assert
    for (const [index, { lines, delivered, reason }] of cases.entries()) {
      const world = await fixture(`notification-ledger-corrupt-${index}`);
      await writeLines(world, lines);
      const found = await world.ledger.find('direct:req-1');
      should(found?.requested).containDeep({ key: 'direct:req-1', phase: 'requested' });
      should(found?.outcome !== undefined).equal(delivered);
      should(world.warnings).have.length(1);
      should(world.warnings[0]).containEql('1 unreadable line skipped').and.containEql(reason);
    }
  });

  it('should say the skipped count only when it changes, and say when the ledger reads cleanly again', async () => {
    // Arrange
    const world = await fixture('notification-ledger-skip-told');
    await writeLines(world, ['not json', requested()]);

    // Act
    await world.ledger.find('direct:req-1');
    await world.ledger.find('direct:req-1');
    await Bun.write(world.ledger.path, `not json\nnot json either\n${JSON.stringify(requested())}\n`);
    await world.ledger.find('direct:req-1');
    await writeLines(world, [requested()]);
    await world.ledger.find('direct:req-1');

    // Assert
    should(world.warnings).have.length(3);
    should(world.warnings[0]).containEql('1 unreadable line skipped (first: line 1, malformed JSON)');
    should(world.warnings[1]).containEql('2 unreadable lines skipped');
    should(world.warnings[2]).containEql('reads cleanly again');
  });

  it('should inspect a ledger: the lines it skips and its newest outcome', async () => {
    // Arrange
    const world = await fixture('notification-ledger-inspect');
    const empty = await world.ledger.inspect();
    await writeLines(world, ['not json', requested(), outcome(), requested('direct:req-2')]);

    // Act
    const health = await world.ledger.inspect();

    // Assert
    should(empty).eql({ readable: true, skipped: 0 });
    should(health).containDeep({ readable: true, skipped: 1, latestOutcome: { key: 'direct:req-1', delivered: 1 } });
  });

  it('should inspect a ledger it cannot read as unreadable, with the reason', async () => {
    // Arrange
    const world = await fixture('notification-ledger-inspect-unreadable');
    const ledger = new FileNotificationDeliveryLedger(world.paths, {
      readText: async () => {
        throw new Error('permission denied');
      },
      appendLineDurable: async (path, line) => await world.files.appendLineDurable(path, line),
    });

    // Act
    const health = await ledger.inspect();

    // Assert
    should(health).eql({ readable: false, reason: 'permission denied' });
    await should(ledger.find('direct:req-1')).be.rejectedWith('permission denied');
  });

  it('should accept other valid keys and independently merge interleaved phases', async () => {
    // Arrange
    const world = await fixture('notification-ledger-interleaved');
    const first = requested('direct:first', 'session-1');
    const second = requested('direct:second', 'session-2');

    // Act
    await world.ledger.append(first);
    await world.ledger.append(second);
    await world.ledger.append(outcome('direct:first'));
    await world.ledger.append(outcome('direct:second'));
    const firstFound = await world.ledger.find('direct:first');
    const secondFound = await world.ledger.find('direct:second');

    // Assert
    should(firstFound).containDeep({ requested: { sessionId: 'session-1' }, outcome: { delivered: 1 } });
    should(secondFound).containDeep({ requested: { sessionId: 'session-2' }, outcome: { delivered: 1 } });
  });

  it('should round-trip an agenda-origin sent body without inventing a request block', async () => {
    // Arrange
    const world = await fixture('notification-ledger-agenda');

    // Act
    await world.ledger.append(agendaRequested());
    const found = await world.ledger.find('attention:session-1:A1');

    // Assert
    should(found?.requested).containDeep({
      origin: 'attention',
      agendaId: 'A1',
      sent: { body: 'The rollout needs a human decision.' },
    });
    should(found?.requested).not.have.property('request');
  });

  it('should keep a more-info push apart from the first announcement of the same item', async () => {
    // Arrange
    const world = await fixture('notification-ledger-info');
    const first = agendaRequested();

    // Act
    await world.ledger.append(first);
    await world.ledger.append(
      NotificationRecordSchema.parse({ ...first, key: 'attention:session-1:A1:info-1', infoRequest: 1 }),
    );
    const info = await world.ledger.find('attention:session-1:A1:info-1');

    // Assert
    should(info?.requested).containDeep({ agendaId: 'A1', infoRequest: 1 });
    should((await world.ledger.find('attention:session-1:A1'))?.requested).not.have.property('infoRequest');
  });

  it('should preserve decisions across freshly constructed adapter instances', async () => {
    // Arrange
    const world = await fixture('notification-ledger-restart');
    await world.ledger.append(requested());
    await world.ledger.append(outcome());
    const restarted = new FileNotificationDeliveryLedger(world.paths, world.files);

    // Act
    const found = await restarted.find('direct:req-1');

    // Assert
    should(found).containDeep({ requested: { phase: 'requested' }, outcome: { phase: 'outcome' } });
  });
});
