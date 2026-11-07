import { describe, it } from 'bun:test';
import {
  CLONE_REVIEW_STALE,
  type CloneReviewItem,
  type FleetAccountChange,
  type FleetCloneReview,
  FleetCloneReviewSchema,
} from '@ferretry/protocol';
import should from 'should';
import { registerMachineCommands } from '../../../src/lib/machine/commands.ts';
import { bundle, cloneReview, fakeWorld, runCommand } from '../fleet/account-fakes.ts';

const item = (ref: string, outcome: CloneReviewItem['outcome'], overrides: Partial<CloneReviewItem> = {}) =>
  ({
    ref,
    kind: 'mcp',
    outcome,
    match: 'key',
    files: [],
    ...(outcome === 'both' ? {} : { choice: outcome === 'new' ? 'add' : outcome === 'theirs' ? 'take' : 'keep' }),
    ...overrides,
  }) as CloneReviewItem;

const update = (overrides: Partial<FleetCloneReview> = {}): FleetCloneReview =>
  cloneReview({
    mode: 'update',
    source: { name: 'laptop', lastCopiedAt: '2026-10-28T09:30:00.000Z', verified: 'self' },
    fingerprint: 'fp-update',
    ...overrides,
  });

const FILES = { 'setup.json': JSON.stringify(bundle()) };

const gatewayReviewing = (review: FleetCloneReview) => ({ reviewClone: () => review });

/** The changes the command staged, in order. */
const staged = (world: ReturnType<typeof fakeWorld>): FleetAccountChange[] =>
  world.gateway.called('stage').map(call => call.args[0] as FleetAccountChange);

const run = async (world: ReturnType<typeof fakeWorld>, ...argv: string[]): Promise<void> =>
  await runCommand(registerMachineCommands, world, ['machine', 'clone', ...argv]);

describe('machine clone: which copy it is', () => {
  it('should ask the daemon to review the export first, and copy alongside when this is the first copy', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.gateway.called('reviewClone')).have.length(1);
    should(world.gateway.called('reviewClone')[0]?.args[0]).match({ bundle: { machine: 'laptop' } });
    should(staged(world).map(change => (change as { mode?: string }).mode)).eql(['alongside']);
  });

  it('should not look at an earlier copy for --alongside or --replace, and keep their one question for a replace', async () => {
    // Arrange
    const world = fakeWorld({ answers: ['y'], files: FILES });

    // Act
    await run(world, 'setup.json', '--alongside');
    await run(world, 'setup.json', '--replace');

    // Assert
    should(world.gateway.called('reviewClone')).have.length(0);
    should(staged(world).map(change => (change as { mode?: string }).mode)).eql(['alongside', 'replace']);
    should(world.prompt.questions).have.length(1);
  });

  it('should refuse --replace with --alongside, and a choice flag on a copy that has nothing to choose between', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES });

    // Act / Assert
    await should(run(world, 'setup.json', '--replace', '--alongside')).be.rejectedWith(/Pick one/u);
    await should(run(world, 'setup.json', '--replace', '--theirs', 'mcp/notes')).be.rejectedWith(
      /--theirs.*only an update has.*--replace copies everything/u,
    );
    await should(run(world, 'setup.json', '--alongside', '--login', 'a=b', '--mine', 'x')).be.rejectedWith(
      /--mine, --login/u,
    );
    should(staged(world)).have.length(0);
  });

  it('should refuse a choice flag on the first copy from a machine, saying there is only one version', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES });

    // Act / Assert
    await should(run(world, 'setup.json', '--remove', 'mcp/notes')).be.rejectedWith(
      /--remove.*laptop has not been copied here before/u,
    );
    should(staged(world)).have.length(0);
  });

  it('should print the review itself for a first copy asked for as a dry run in JSON, and write nothing', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(cloneReview({ fingerprint: 'fp-first' })) });

    // Act
    await run(world, 'setup.json', '--dry-run', '--json');

    // Assert
    should(FleetCloneReviewSchema.parse(JSON.parse(world.out.text('report'))).fingerprint).equal('fp-first');
    should(staged(world)).have.length(0);
  });

  it('should name the file when none is given', async () => {
    await should(run(fakeWorld())).be.rejectedWith(/Name the setup to copy: fz machine clone <file>/u);
  });
});

describe('machine clone: an update', () => {
  const changed = update({
    items: [
      item('mcp/notes', 'new'),
      item('hooks/guard', 'theirs', { kind: 'hooks' }),
      item('runtime/old', 'gone', { kind: 'runtime' }),
    ],
    same: { count: 2, probable: 1 },
  });

  it('should show the diff and write nothing for --dry-run', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(changed) });

    // Act
    await run(world, 'setup.json', '--dry-run');

    // Assert
    const text = world.out.text('report');
    should(text).startWith('Update from laptop (last copied 2026-10-28)');
    should(text)
      .containEql('New on laptop (1)')
      .and.containEql('Changed on laptop (1)')
      .and.containEql('Gone from laptop — kept here (1)')
      .and.containEql('2 things already the same (1 matched by name).')
      .and.endWith('Dry run: nothing was changed.');
    should(staged(world)).have.length(0);
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should print only the review, as JSON that parses with the schema, for --dry-run --json', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(changed) });

    // Act
    await run(world, 'setup.json', '--dry-run', '--json');

    // Assert
    should(world.out.lines).have.length(1);
    should(FleetCloneReviewSchema.parse(JSON.parse(world.out.text('report')))).eql(changed);
  });

  it('should apply the review it showed, naming its fingerprint and the choices, and not ask for a plain update', async () => {
    // Arrange
    const plain = update({ items: [item('hooks/guard', 'theirs', { kind: 'hooks' })] });
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(plain) });

    // Act
    await run(world, 'setup.json', '--mine', 'hooks/guard');

    // Assert
    const [change] = staged(world);
    should(change).match({
      kind: 'clone.import',
      mode: 'update',
      decisions: { 'hooks/guard': 'keep' },
      reviewed: 'fp-update',
    });
    should(change).not.have.property('logins');
    should(change).not.have.property('skip');
    should(world.prompt.questions).have.length(0);
    should(world.gateway.called('apply')).have.length(1);
    should(world.out.text()).containEql('Update from laptop');
  });

  it('should send --skip as a decision, so a left-out item is not written and is named in the review it matched', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(changed), answers: ['y'] });

    // Act
    await run(world, 'setup.json', '--skip', 'mcp/notes', '--remove', 'runtime/old');

    // Assert
    should((staged(world)[0] as { decisions: unknown }).decisions).eql({
      'mcp/notes': 'skip',
      'runtime/old': 'remove',
    });
  });

  it('should ask before removing anything, and stop on a no', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(changed), answers: ['n'] });

    // Act
    await run(world, 'setup.json', '--remove', 'runtime/old');

    // Assert
    should(world.prompt.questions).eql(['Go ahead? [y/N]']);
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should refuse a flag that names nothing in the review, before anything is staged', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(changed) });

    // Act / Assert
    await should(run(world, 'setup.json', '--theirs', 'mcp/typo')).be.rejectedWith(
      /--theirs mcp\/typo: nothing called mcp\/typo differs.*Nothing was changed\./su,
    );
    should(staged(world)).have.length(0);
  });

  it('should say there is nothing to copy, and stage nothing, when nothing differs and nothing is only matched by name', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(update({ same: { count: 4, probable: 0 } })) });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.out.text('success')).equal('Everything from laptop is already here. Nothing to copy.');
    should(staged(world)).have.length(0);
  });

  it('should still apply when nothing differs but copies matched only by name are to be linked', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(update({ same: { count: 4, probable: 2 } })) });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(staged(world)).have.length(1);
    should(staged(world)[0]).match({ mode: 'update', reviewed: 'fp-update' });
  });

  it('should print the review as JSON when nothing differs and --json is on', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(update()) });

    // Act
    await run(world, 'setup.json', '--json');

    // Assert
    should(FleetCloneReviewSchema.parse(JSON.parse(world.out.text('report'))).mode).equal('update');
    should(staged(world)).have.length(0);
  });

  it('should print a stale review plainly, with how to look again, and apply nothing', async () => {
    // Arrange
    const world = fakeWorld({
      files: FILES,
      gateway: {
        ...gatewayReviewing(update({ items: [item('mcp/notes', 'new')] })),
        stage: () => {
          throw new Error(CLONE_REVIEW_STALE);
        },
      },
    });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith(
      `${CLONE_REVIEW_STALE} Nothing was changed. Run \`fz machine clone <file> --dry-run\` to see the new review.`,
    );
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should pass any other refusal on as it came', async () => {
    // Arrange
    const world = fakeWorld({
      files: FILES,
      gateway: {
        ...gatewayReviewing(update({ items: [item('mcp/notes', 'new')] })),
        stage: () => {
          throw new Error('That setup was exported from this machine itself.');
        },
      },
    });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith('That setup was exported from this machine itself.');
  });

  it('should say where to sign in after an update that adds an empty slot, and not after one that adds none', async () => {
    // Arrange
    const withSlot = fakeWorld({
      files: FILES,
      gateway: gatewayReviewing(
        update({ items: [item('mcp/notes', 'new')], logins: [{ sourceId: 'claude-work', outcome: 'slot' }] }),
      ),
    });
    const without = fakeWorld({
      files: FILES,
      gateway: gatewayReviewing(update({ items: [item('mcp/notes', 'new')] })),
    });

    // Act
    await run(withSlot, 'setup.json');
    await run(without, 'setup.json');

    // Assert
    should(withSlot.out.text()).containEql('fz credentials');
    should(without.out.text()).not.containEql('fz credentials');
  });
});

describe('machine clone: an environment login the update adds', () => {
  const environment = update({
    items: [item('runtime/agent', 'new', { kind: 'runtime' })],
    logins: [
      {
        sourceId: 'api',
        outcome: 'slot',
        runnable: { entries: [{ label: 'NODE_OPTIONS', text: '--require /tmp/probe.cjs', document: false }] },
      },
    ],
  });

  it('should show what the login is configured with before anything is applied, with --dry-run', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(environment) });

    // Act
    await run(world, 'setup.json', '--dry-run');

    // Assert
    should(world.out.text()).containEql('Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should refuse off a terminal without --yes, after showing it, and apply nothing', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(environment) });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.out.text()).containEql('Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
    should(world.out.exitCode).equal(1);
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should ask at a terminal, and stop on a no', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(environment), answers: ['n'] });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.prompt.questions).eql(['Go ahead? [y/N]']);
    should(world.gateway.called('apply')).have.length(0);
  });

  it('should apply with --yes, bound to the review that listed the login', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(environment) });

    // Act
    await run(world, 'setup.json', '--yes');

    // Assert
    should(staged(world)[0]).match({ kind: 'clone.import', reviewed: 'fp-update' });
    should(world.out.text()).containEql('Runs: NODE_OPTIONS: --require /tmp/probe.cjs');
    should(world.gateway.called('apply')).have.length(1);
  });

  it('should not ask when the runtime that would use it is left out', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(environment) });

    // Act
    await run(world, 'setup.json', '--skip', 'runtime/agent');

    // Assert
    should(world.gateway.called('apply')).have.length(1);
  });
});

describe('machine clone: both sides changed (nothing is pre-selected)', () => {
  const both = update({
    items: [item('settings/shared', 'both', { kind: 'settings', fields: ['args'] }), item('hooks/guard', 'both')],
  });

  it('should refuse off a terminal, listing every item that needs a choice, and stage nothing', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(both) });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith(
      /Both machines changed these, and nothing is chosen for you:\n {2}settings\/shared\n {2}hooks\/guard\nChoose each with --theirs <item> to take laptop's, or --mine <item> to keep yours\. Nothing was changed\./u,
    );
    should(staged(world)).have.length(0);
  });

  it('should refuse with --yes even at a terminal: yes is not a choice', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(both) });

    // Act / Assert
    await should(run(world, 'setup.json', '--yes')).be.rejectedWith(/nothing is chosen for you/u);
    should(world.prompt.questions).have.length(0);
    should(staged(world)).have.length(0);
  });

  it('should refuse with --json, which is for scripts, and for the one item left after a partial choice', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(both) });

    // Act / Assert
    await should(run(world, 'setup.json', '--json', '--theirs', 'settings/shared')).be.rejectedWith(
      /Both machines changed this, and nothing is chosen for you:\n {2}hooks\/guard\n/u,
    );
  });

  it('should take the choices of the flags, and apply once every one has one', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(both) });

    // Act
    await run(world, 'setup.json', '--theirs', 'settings/shared', '--mine', 'hooks/guard');

    // Assert
    should((staged(world)[0] as { decisions: unknown }).decisions).eql({
      'settings/shared': 'take',
      'hooks/guard': 'keep',
    });
  });

  it('should still print the diff for --dry-run when nothing is chosen, and say each one needs a choice', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(both) });

    // Act
    await run(world, 'setup.json', '--dry-run');

    // Assert
    should(world.out.text('report')).containEql('Both changed — choose (2)').and.containEql('needs your choice');
    should(world.out.exitCode).be.undefined();
    should(staged(world)).have.length(0);
  });

  it('should ask each one at a terminal: keep mine, take theirs, or show both and ask again', async () => {
    // Arrange
    const world = fakeWorld({
      files: FILES,
      gateway: gatewayReviewing(both),
      answers: ['s', 'T', 'keep'],
    });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.prompt.questions).eql([
      'settings/shared: both sides changed it. [k]eep mine / [t]ake theirs / [s]how both',
      'settings/shared: both sides changed it. [k]eep mine / [t]ake theirs / [s]how both',
      'hooks/guard: both sides changed it. [k]eep mine / [t]ake theirs / [s]how both',
    ]);
    should(world.out.text('report')).containEql('settings/shared — both sides changed it');
    should((staged(world)[0] as { decisions: unknown }).decisions).eql({
      'settings/shared': 'take',
      'hooks/guard': 'keep',
    });
  });

  it('should stop with nothing changed when the answers are not a choice', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(both), answers: ['maybe', '', 'x'] });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith(
      'No choice was made for settings/shared. Nothing was changed.',
    );
    should(staged(world)).have.length(0);
  });

  it('should stop when it is shown the item over and over without ever choosing', async () => {
    // Arrange
    const world = fakeWorld({
      files: FILES,
      gateway: gatewayReviewing(update({ items: [item('hooks/guard', 'both')] })),
      answers: Array.from({ length: 6 }, () => 's'),
    });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith('No choice was made for hooks/guard. Nothing was changed.');
    should(staged(world)).have.length(0);
  });
});

describe('machine clone: a login the daemon could not match', () => {
  const ask = update({
    items: [item('mcp/notes', 'new')],
    logins: [{ sourceId: 'claude-work', outcome: 'ask', candidates: ['claude-a', 'claude-b'] }],
  });

  it('should refuse off a terminal, listing each login and its candidates', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(ask) });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith(
      /nothing picks one for you:\n {2}claude-work: claude-a, claude-b\nAnswer each with --login <source login>=<login here>, or =slot/u,
    );
    should(staged(world)).have.length(0);
  });

  it('should pass the answers of --login on, and add no slot for one that names an existing login', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, interactive: false, gateway: gatewayReviewing(ask) });

    // Act
    await run(world, 'setup.json', '--login', 'claude-work=claude-b');

    // Assert
    should(staged(world)[0]).match({ mode: 'update', logins: { 'claude-work': 'claude-b' } });
    should(world.out.text()).not.containEql('fz credentials');
  });

  it('should refuse an answer that is not a candidate before anything is staged', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(ask) });

    // Act / Assert
    await should(run(world, 'setup.json', '--login', 'claude-work=claude-z')).be.rejectedWith(
      /pick one of claude-a, claude-b, or slot/u,
    );
    should(staged(world)).have.length(0);
  });

  it('should ask at a terminal, and say where to sign in when the answer is a new empty slot', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(ask), answers: ['nope', 'slot'] });

    // Act
    await run(world, 'setup.json');

    // Assert
    should(world.prompt.questions[0]).equal(
      'Which login here is claude-work? claude-a / claude-b / slot (a new empty one)',
    );
    should(staged(world)[0]).match({ logins: { 'claude-work': 'slot' } });
    should(world.out.text()).containEql('fz credentials');
  });

  it('should stop when no login is chosen', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES, gateway: gatewayReviewing(ask), answers: ['', '', ''] });

    // Act / Assert
    await should(run(world, 'setup.json')).be.rejectedWith('No login was chosen for claude-work. Nothing was changed.');
    should(staged(world)).have.length(0);
  });
});

describe('machine clone --forget', () => {
  it('should drop the record of one source through the daemon and say nothing else was touched', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    await run(world, '--forget', 'studio-mac');

    // Assert
    should(world.gateway.called('forgetCloneSource')[0]?.args).eql(['studio-mac']);
    should(world.out.text('success')).match(
      /^Forgot studio-mac: .*Nothing copied, no login and no secret is touched\.$/u,
    );
    should(staged(world)).have.length(0);
  });

  it('should say when there was nothing to forget', async () => {
    // Arrange
    const world = fakeWorld({ gateway: { forgetCloneSource: () => false } });

    // Act
    await run(world, '--forget', 'nobody');

    // Assert
    should(world.out.text('report')).equal('There is no record of nobody, so there is nothing to forget.');
  });

  it('should print the answer as JSON, and for --dry-run only say what it would do', async () => {
    // Arrange
    const world = fakeWorld();

    // Act
    await run(world, '--forget', 'studio-mac', '--json');
    await run(world, '--forget', 'studio-mac', '--dry-run');

    // Assert
    should(JSON.parse(world.out.lines[0]?.text ?? '')).eql({ source: 'studio-mac', forgotten: true });
    should(world.out.lines[1]?.text).match(/^Dry run: the next copy from studio-mac starts as if there had been none/u);
    should(world.gateway.called('forgetCloneSource')).have.length(1);
  });

  it('should stand alone: a file or another mode beside it is refused and nothing is forgotten', async () => {
    // Arrange
    const world = fakeWorld({ files: FILES });

    // Act / Assert
    await should(run(world, 'setup.json', '--forget', 'studio-mac')).be.rejectedWith(
      /--forget stands alone.*Remove setup\.json\./u,
    );
    await should(run(world, '--forget', 'studio-mac', '--replace', '--skip', 'a', '--theirs', 'b')).be.rejectedWith(
      /Remove --replace, --skip, --theirs\./u,
    );
    should(world.gateway.called('forgetCloneSource')).have.length(0);
  });
});
