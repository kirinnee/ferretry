import { describe, it } from 'bun:test';
import { AgendaSnapshotSchema } from '@ferretry/protocol';
import should from 'should';
import { renderAgendaHistory, renderAgendaList, renderAgendaMutation } from '../../../src/lib/agenda/render';
import { agentItem, humanItem, resolvedItem, SESSION, snapshot } from './fixtures';

const row = (text: string, index: number): string => text.split('\n')[index] ?? '';

describe('attention fixtures', () => {
  it('should be shapes the protocol actually accepts', () => {
    // Act
    const actual = AgendaSnapshotSchema.safeParse(
      snapshot([humanItem('A1', 'approve the deploy'), agentItem('A2', 'pick a cluster')], {
        resolved: [resolvedItem('A3', 'old thing')],
      }),
    );

    // Assert — rendering a shape the wire would reject proves nothing.
    should(actual.success).be.true();
  });
});

describe('attention listing', () => {
  it('should say so when nothing is waiting', () => {
    // Act
    const actual = renderAgendaList(snapshot([]));

    // Assert
    should(actual).equal('Nothing on the agenda.');
  });

  it('should head the listing with a singular count for one item', () => {
    // Act
    const actual = renderAgendaList(snapshot([humanItem('A1', 'approve the deploy')]));

    // Assert
    should(row(actual, 0)).equal(`1 open item in ${SESSION} — oldest first`);
  });

  it('should render an item as its reference, source and subject', () => {
    // Act
    const actual = renderAgendaList(snapshot([humanItem('A1', 'approve  the\n deploy')]));

    // Assert — the subject is flattened so the head of an item is always one line.
    should(row(actual, 1)).equal('  !A1  [question]  approve the deploy');
  });

  it('should show why, how to resolve, and who raised it', () => {
    // Act
    const actual = renderAgendaList(snapshot([agentItem('A2', 'pick a cluster')]));

    // Assert
    should(row(actual, 3)).equal('      why: nothing else can proceed');
    should(row(actual, 4)).equal('      resolve: answer on the board');
    should(row(actual, 5)).equal('      since 2026-07-31T09:05:00.000Z · raised by agent sol');
  });

  it('should print a legacy default howToResolve as the current agenda default', () => {
    // Act
    const actual = renderAgendaList(
      snapshot([humanItem('A1', 'approve', { howToResolve: 'Answer this item on the agenda board.' })]),
    );

    // Assert
    should(actual).containEql('resolve: Answer this item on the agenda (it records who answered).');
    should(actual).not.containEql('attention board');
  });

  it('should not invent a name for an unnamed agent', () => {
    // Act
    const actual = renderAgendaList(snapshot([agentItem('A2', 'pick a cluster', { raisedByName: null })]));

    // Assert
    should(actual).containEql('raised by agent');
    should(actual).not.containEql('agent null');
  });

  it('should include context only when there is some', () => {
    // Act
    const withContext = renderAgendaList(snapshot([humanItem('A1', 'x', { context: 'the CI job times out' })]));
    const withBlank = renderAgendaList(snapshot([humanItem('A1', 'x', { context: '   ' })]));

    // Assert
    should(withContext).containEql('      context: the CI job times out');
    should(withBlank).not.containEql('context:');
  });

  it('should print the premise before the context and the decided points after it, only when there are some', () => {
    // Act
    const full = renderAgendaList(
      snapshot([
        humanItem('A1', 'x', {
          premise: '- login expires',
          context: 'keepalive fixes it',
          decided: '- shared account',
        }),
      ]),
    );
    const blank = renderAgendaList(snapshot([humanItem('A1', 'x', { premise: '  ', decided: ' ' })]));

    // Assert
    should(full).containEql('      premise: - login expires');
    should(full).containEql('      decided: - shared account');
    should(full.indexOf('premise:')).be.below(full.indexOf('context:'));
    should(full.indexOf('context:')).be.below(full.indexOf('decided:'));
    should(blank).not.containEql('premise:');
    should(blank).not.containEql('decided:');
  });

  it('should print the still-open points right after the decided ones, only when there are some', () => {
    // Act
    const full = renderAgendaList(
      snapshot([humanItem('A1', 'x', { decided: '- shared account', stillOpen: '- rollback plan' })]),
    );
    const blank = renderAgendaList(snapshot([humanItem('A1', 'x', { stillOpen: ' ' })]));

    // Assert
    should(full).containEql('      still open: - rollback plan');
    should(full.indexOf('decided:')).be.below(full.indexOf('still open:'));
    should(blank).not.containEql('still open:');
  });

  it('should print the structured brief, and drop a why that only repeats the summary', () => {
    // Act
    const rich = renderAgendaList(
      snapshot([
        humanItem('A1', 'Approve the plan', {
          why: 'Approve the plan',
          terms: [{ term: 'OCI', meaning: 'Oracle Cloud Infrastructure' }],
          questions: [
            {
              question: 'Which plan?',
              options: [{ label: 'Defaults' }, { label: 'Changes' }],
              recommended: 'Defaults',
              why: 'It runs today',
            },
            { question: 'When?' },
          ],
          recommendation: { decision: 'Defaults, today', why: 'Lowest risk' },
          impact: 'You stay logged out',
          urgency: 'today',
          links: [{ label: 'Plan', target: '#F12' }, { target: 'https://example.invalid/pr/1' }],
        }),
      ]),
    );

    // Assert
    should(rich).containEql('      q1: Which plan?');
    should(rich).containEql('        options: "Defaults" | "Changes"');
    should(rich).containEql('        recommended: Defaults — It runs today');
    should(rich).containEql('      q2: When?');
    should(rich).containEql('      recommend: Defaults, today — Lowest risk');
    should(rich).containEql('      impact: You stay logged out — by today');
    should(rich).containEql('      terms: OCI = Oracle Cloud Infrastructure');
    should(rich).containEql('      links: Plan · https://example.invalid/pr/1');
    should(rich).not.containEql('why:');
  });

  it('should print each option detail under the item', () => {
    // Act
    const rich = renderAgendaList(
      snapshot([
        humanItem('A1', 'Approve the plan', {
          optionDetails: [{ label: 'Go', detail: 'Ship it **now**' }],
        }),
      ]),
    );

    // Assert
    should(rich).containEql('      option "Go": Ship it **now**');
  });

  it('should spell out what each ask kind wants from the human', () => {
    // Act
    const permission = renderAgendaList(snapshot([humanItem('A1', 'x', { ask: { kind: 'permission' } })]));
    const review = renderAgendaList(snapshot([humanItem('A1', 'x', { ask: { kind: 'answer-review' } })]));
    const open = renderAgendaList(snapshot([humanItem('A1', 'x', { ask: { kind: 'open-question' } })]));
    const choice = renderAgendaList(
      snapshot([
        humanItem('A1', 'x', {
          ask: { kind: 'multiple-choice', options: [{ label: 'ship it' }, { label: 'hold' }] },
        }),
      ]),
    );

    // Assert
    should(permission).containEql('answers: ← Deny · → Approve');
    should(review).containEql('answers: ← Request changes · → Approve');
    should(open).containEql('answer: write a full answer');
    should(choice).containEql('answers: ← ship it · → hold');
  });

  it('should say several questions want one reply, each answer numbered, and offer them no answers', () => {
    // Act
    const several = renderAgendaList(
      snapshot([
        humanItem('A1', 'x', {
          ask: { kind: 'open-question' },
          questions: [
            { question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }] },
            { question: 'OK to restart?' },
          ],
        }),
      ]),
    );

    // Assert
    should(several).containEql('answer: one reply, each answer numbered');
    should(several).not.containEql('answers: ←');
  });

  it('should omit the answer hint for an item with no ask', () => {
    // Act
    const actual = renderAgendaList(snapshot([humanItem('A1', 'x')]));

    // Assert
    should(actual).not.containEql('answer:');
  });

  it('should order items oldest first, whatever order the daemon sent', () => {
    // Arrange
    const newer = humanItem('A2', 'newer', { waitingSince: '2026-07-31T12:00:00.000Z' });
    const older = humanItem('A1', 'older', { waitingSince: '2026-07-31T08:00:00.000Z' });

    // Act — kteam printed "oldest first" and then trusted the daemon's order.
    const actual = renderAgendaList(snapshot([newer, older]));

    // Assert
    should(row(actual, 1)).containEql('older');
  });

  it('should break an equal wait on the item ordinal', () => {
    // Arrange
    const at = '2026-07-31T08:00:00.000Z';
    const second = humanItem('A2', 'second', { waitingSince: at });
    const first = humanItem('A1', 'first', { waitingSince: at });

    // Act
    const actual = renderAgendaList(snapshot([second, first]));

    // Assert
    should(row(actual, 1)).containEql('first');
  });

  it('should warn about unreadable entries while still listing the readable ones', () => {
    // Act — kteam replaced the entire list with this warning, hiding every valid item.
    const actual = renderAgendaList(snapshot([humanItem('A1', 'still urgent')], { parseErrors: 2 }));

    // Assert
    should(row(actual, 0)).equal(
      'Warning: 2 entries on this agenda could not be read; the list below may be incomplete.',
    );
    should(actual).containEql('still urgent');
  });

  it('should count a single unreadable entry in the singular', () => {
    // Act
    const actual = renderAgendaList(snapshot([], { parseErrors: 1 }));

    // Assert
    should(row(actual, 0)).containEql('Warning: 1 entry on this agenda');
    should(row(actual, 1)).equal('Nothing on the agenda.');
  });

  it('should elide a subject longer than the row budget', () => {
    // Act
    const actual = renderAgendaList(snapshot([humanItem('A1', 'q'.repeat(120))]));

    // Assert
    should(actual).containEql(`${'q'.repeat(83)}…`);
  });
});

describe('attention history', () => {
  it('should say so when nothing has been resolved', () => {
    // Act
    const actual = renderAgendaHistory(snapshot([]));

    // Assert
    should(actual).equal('No recorded resolutions.');
  });

  it('should record who resolved an item and when', () => {
    // Act
    const actual = renderAgendaHistory(snapshot([], { resolved: [resolvedItem('A1', 'approve the deploy')] }));

    // Assert
    should(row(actual, 0)).equal(`Recent resolutions in ${SESSION} — newest first`);
    should(row(actual, 1)).equal('  !A1  approve the deploy · resolved by human at 2026-07-31T10:00:00.000Z');
  });

  it('should name a dismissal as a dismissal', () => {
    // Act
    const actual = renderAgendaHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'stale ask', { disposition: 'dismissed' })] }),
    );

    // Assert
    should(actual).containEql('· dismissed by human at');
  });

  it('should name an owner reply as a reply, not a resolution', () => {
    // Act
    const actual = renderAgendaHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'which region', { disposition: 'replied' })] }),
    );

    // Assert
    should(actual).containEql('· replied by human at');
  });

  it('should show the recorded answer and note', () => {
    // Act
    const actual = renderAgendaHistory(
      snapshot([], {
        resolved: [
          resolvedItem('A1', 'approve the deploy', {
            ask: { kind: 'permission' },
            response: { kind: 'permission', decision: 'approve' },
            resolutionNote: 'after the smoke test passed',
          }),
        ],
      }),
    );

    // Assert
    should(actual).containEql('— approved — after the smoke test passed');
  });

  it('should omit a blank note', () => {
    // Act
    const actual = renderAgendaHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'x', { resolutionNote: '   ' })] }),
    );

    // Assert
    should(actual).not.containEql('—  ');
  });

  it('should name the agent that resolved an item', () => {
    // Act
    const actual = renderAgendaHistory(
      snapshot([], { resolved: [resolvedItem('A1', 'x', { resolvedBy: 'agent', resolvedByName: 'sol' })] }),
    );

    // Assert
    should(actual).containEql('resolved by agent sol at');
  });

  it('should order resolutions newest first', () => {
    // Arrange
    const older = resolvedItem('A1', 'older', { resolvedAt: '2026-07-31T09:00:00.000Z' });
    const newer = resolvedItem('A2', 'newer', { resolvedAt: '2026-07-31T11:00:00.000Z' });

    // Act
    const actual = renderAgendaHistory(snapshot([], { resolved: [older, newer] }));

    // Assert
    should(row(actual, 1)).containEql('newer');
  });

  it('should break an equal resolution time on the item ordinal, newest id first', () => {
    // Arrange
    const at = '2026-07-31T09:00:00.000Z';
    const first = resolvedItem('A1', 'first', { resolvedAt: at });
    const second = resolvedItem('A2', 'second', { resolvedAt: at });

    // Act
    const actual = renderAgendaHistory(snapshot([], { resolved: [first, second] }));

    // Assert
    should(row(actual, 1)).containEql('second');
  });

  it('should warn about unreadable entries here too', () => {
    // Act
    const actual = renderAgendaHistory(snapshot([], { parseErrors: 1 }));

    // Assert
    should(row(actual, 0)).containEql('could not be read');
  });
});

describe('attention confirmations', () => {
  it('should report a mutation with the reference and what is still waiting', () => {
    // Act
    const actual = renderAgendaMutation('resolved', '!A3', snapshot([humanItem('A1', 'x')]));

    // Assert
    should(actual).equal(`resolved !A3 — 1 open item in ${SESSION}`);
  });

  it('should report a mutation that names no reference', () => {
    // Act
    const actual = renderAgendaMutation('attention recorded', undefined, snapshot([]));

    // Assert
    should(actual).equal(`attention recorded — 0 open items in ${SESSION}`);
  });

  it('should warn when the raise reached no device, and say nothing when one was enrolled', () => {
    // Arrange
    const nobody = { ...snapshot([humanItem('A1', 'x')]), enrolled: 0 };
    const somebody = { ...snapshot([humanItem('A1', 'x')]), enrolled: 2 };

    // Act
    const warned = renderAgendaMutation('attention !A1 recorded', undefined, nobody, 'A1');
    const quiet = renderAgendaMutation('attention !A1 recorded', undefined, somebody, 'A1');

    // Assert
    should(warned.split('\n')[1]).startWith('Warning: no device will be notified (0 enrolled).');
    should(quiet).equal(`attention !A1 recorded — 1 open item in ${SESSION}`);
  });
});

describe('writing advice', () => {
  it('should print the daemon warnings under the confirmation, with the fix to run', () => {
    // Arrange
    const warned = {
      ...snapshot([]),
      warnings: ['summary is 120 characters; keep it under 90', 'links ("https://x.example")'],
    };

    // Act
    const actual = renderAgendaMutation('attention A4 recorded', undefined, warned, 'A4');

    // Assert
    should(actual.split('\n')).deepEqual([
      `attention A4 recorded — 0 open items in ${SESSION}`,
      "Reads hard for someone who hasn't followed — fix it with `agenda edit !A4`:",
      '  - summary is 120 characters; keep it under 90',
      '  - links ("https://x.example")',
    ]);
  });

  it('should name no id when the new item could not be told apart', () => {
    // Arrange
    const warned = { ...snapshot([]), warnings: ['summary is long'] };

    // Act
    const actual = renderAgendaMutation('attention recorded', undefined, warned);

    // Assert
    should(actual).containEql('fix it with `agenda edit <id>`');
  });
});

describe('attention listing steps and body', () => {
  it('should number the steps with a tick on the done ones, then show the body', () => {
    // Act
    const actual = renderAgendaList(
      snapshot([
        agentItem('A1', 'log in', {
          steps: ['Run `fy login`', 'Paste the code', 'Press Enter'],
          stepsDone: [0, 2],
          body: 'Some\nnotes',
        }),
      ]),
    );

    // Assert
    should(actual).containEql('steps (2/3 done):');
    should(actual).containEql('1. ✓ Run `fy login`');
    should(actual).containEql('2. · Paste the code');
    should(actual).containEql('3. ✓ Press Enter');
    should(actual).containEql('body: Some notes');
  });
});

describe('attention to-do items', () => {
  it('should say what a task wants and that it waits on the ferret once more information was asked', () => {
    // Act
    const plain = renderAgendaList(snapshot([agentItem('A2', 'log in', { ask: { kind: 'task' } })]));
    const waiting = renderAgendaList(
      snapshot([
        agentItem('A2', 'log in', {
          ask: { kind: 'task' },
          waitingOn: 'ferret',
          askedAt: '2026-07-31T09:10:00.000Z',
        }),
      ]),
    );

    // Assert
    should(plain).containEql('answers: → Mark as done');
    should(plain).not.containEql("ferret's turn");
    should(waiting).containEql("ferret's turn: more information asked 2026-07-31T09:10:00.000Z");
  });
});

describe('agenda turns', () => {
  it('should say whose turn an item is, and what the ferret can do when the owner wrote about it', () => {
    // Act
    const discussed = renderAgendaList(
      snapshot([
        agentItem('A2', 'log in', {
          waitingOn: 'ferret',
          waitingFor: 'discussion',
          askedAt: '2026-07-31T09:10:00.000Z',
        }),
      ]),
    );
    const asked = renderAgendaList(
      snapshot([
        agentItem('A2', 'log in', { waitingOn: 'ferret', waitingFor: 'info', askedAt: '2026-07-31T09:10:00.000Z' }),
      ]),
    );

    // Assert
    should(discussed).containEql("ferret's turn: the owner wrote about this");
    should(discussed).containEql('agenda surface');
    should(asked).containEql("ferret's turn: more information asked");
    should(asked).not.containEql('the owner wrote about this');
  });

  it('should say when a snoozed item comes back, and what the ferret does with one the owner replied to', () => {
    // Act
    const snoozed = renderAgendaList(
      snapshot([
        {
          ...agentItem('A2', 'log in', { neededBy: '2026-07-31T15:00:00.000Z' }),
          parked: { reason: 'snoozed', at: '2026-07-31T09:00:00.000Z', until: '2026-07-31T17:00:00.000Z' },
        },
      ]),
    );
    const replied = renderAgendaList(
      snapshot([
        { ...agentItem('A3', 'pick a region'), parked: { reason: 'replied', at: '2026-07-31T09:10:00.000Z' } },
      ]),
    );

    // Assert — the deadline comes first, so that is when it wakes
    should(snoozed).containEql('snoozed by the owner until 2026-07-31T15:00:00.000Z');
    should(snoozed).containEql('agenda surface --now');
    should(snoozed).not.containEql("owner's turn");
    should(replied).containEql('replied 2026-07-31T09:10:00.000Z: parked');
    should(replied).containEql('agenda edit A3 --summary … --premise … --context …');
    should(replied).not.containEql('agenda surface');
    should(replied).containEql('agenda done');
  });

  it("should say it is the owner's turn on a fresh ask, and print what the item blocks", () => {
    // Act
    const fresh = renderAgendaList(
      snapshot([
        agentItem('A2', 'approve the deploy', {
          blockingNow: true,
          willBlock: 'the 14:00 deploy',
          neededBy: '2026-07-31T14:00:00.000Z',
        }),
      ]),
    );
    const plain = renderAgendaList(snapshot([agentItem('A3', 'pick a color')]));
    const notice = renderAgendaList(snapshot([agentItem('A4', 'build is green', { notice: true, ping: true })]));

    // Assert
    should(fresh).containEql("owner's turn");
    should(fresh).containEql('blocking now: the ferret is stopped until this is answered');
    should(fresh).containEql('will block: the 14:00 deploy');
    should(fresh).containEql('needed by: 2026-07-31T14:00:00.000Z');
    should(plain).not.containEql('blocking now');
    should(plain).not.containEql('needed by');
    should(notice).containEql('notice: read, not answered (pinged)');
    should(notice).not.containEql("owner's turn");
  });
});

describe('attention cards', () => {
  it('should head a titled item by its title, then the ask, then the answers as the swipes point', () => {
    // Act
    const actual = renderAgendaList(
      snapshot([
        humanItem('A1', 'Ship the release now?', {
          title: 'Release',
          kind: 'yesno',
          ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
        }),
      ]),
    );

    // Assert
    should(row(actual, 1)).equal('  !A1  [question]  Release');
    should(row(actual, 2)).equal('      ask: Ship the release now?');
    should(row(actual, 3)).equal('      answers: ← Yes · → No');
  });

  it('should lay a permission card with an up answer out left, up, right', () => {
    // Act
    const actual = renderAgendaList(
      snapshot([
        humanItem('A1', 'Run the migration?', {
          title: 'Migration',
          kind: 'permission',
          ask: { kind: 'permission' },
          answers: [
            { direction: 'left', does: 'reject', label: 'Deny' },
            { direction: 'up', does: 'approve', label: 'Always allow' },
            { direction: 'right', does: 'approve', label: 'Allow' },
          ],
        }),
      ]),
    );

    // Assert
    should(actual).containEql('answers: ← Deny · ↑ Always allow · → Allow');
  });

  it('should keep an old item headed by its ask and still show derived answers', () => {
    // Act
    const actual = renderAgendaList(snapshot([humanItem('A1', 'approve the deploy', { ask: { kind: 'permission' } })]));

    // Assert
    should(row(actual, 1)).equal('  !A1  [question]  approve the deploy');
    should(actual).not.containEql('ask: approve the deploy');
    should(row(actual, 2)).equal('      answers: ← Deny · → Approve');
  });

  it('should name an old item’s options past the third so none is hidden', () => {
    // Act
    const actual = renderAgendaList(
      snapshot([
        humanItem('A1', 'which one', {
          ask: { kind: 'multiple-choice', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }] },
        }),
      ]),
    );

    // Assert
    should(actual).containEql('also "');
    should(actual).containEql('"d"');
  });
});
