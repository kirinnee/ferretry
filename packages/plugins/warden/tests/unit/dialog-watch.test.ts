import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import { AsksWardenAgenda, NoticeEntries } from '../../daemon/asks.ts';
import { agendaDialogNotices, ferretDialogs } from '../../daemon/dialogs.ts';
import {
  type DialogNotice,
  dialogNotice,
  dialogNoticeRef,
  GONE_LOOKS,
  permissionAsDialog,
  planDialogNotices,
  WardenDialogWatch,
  WatchedDialogSchema,
  type WardenFleetSession,
  type WatchedDialog,
  type WatchedDialogWords,
} from '../../daemon/lib/index.ts';

/**
 * O11 step 3: a screen no home key can answer (an MCP approval, a hooks review, a settings error, a tool prompt) stops a
 * ferret until somebody chooses. The Warden tells its owner ONCE per ferret per dialog episode — not once per look.
 */

const words = (over: Partial<WatchedDialogWords> = {}): WatchedDialogWords => ({
  id: 'aaaaaaaaaaaaaaaa',
  harness: 'claude-code',
  kind: 'mcp-servers',
  ...over,
});
const watched = (sessionId: string, over: Partial<WatchedDialogWords> = {}): WatchedDialog => ({
  sessionId,
  name: `${sessionId}-name`,
  dialog: words(over),
});

/** The watch over fakes: what the fleet shows now, what the memory holds, and every notice raised or closed. */
function stand(initial: Record<string, readonly string[]> = {}) {
  let memory: Record<string, readonly string[]> = initial;
  const log = { raised: [] as DialogNotice[], cleared: [] as string[], events: [] as string[] };
  const state = { dialogs: [] as readonly WatchedDialog[], refuse: false, unreadable: false };
  const watch = new WardenDialogWatch({
    dialogs: async () => {
      if (state.unreadable) throw new Error('the fleet could not be read');
      return state.dialogs;
    },
    memory: {
      read: async () => memory,
      write: async next => {
        memory = next;
      },
    },
    notices: {
      raise: async notice => {
        if (state.refuse) return 'rejected';
        log.raised.push(notice);
        return 'created';
      },
      clear: async (sessionId, ref) => {
        log.cleared.push(`${sessionId}|${ref}`);
      },
    },
    record: type => {
      log.events.push(type);
    },
  });
  return { watch, state, log, memory: () => memory };
}

describe('the dialog notice', () => {
  it('should say only fixed words: the ferret, the kind, the harness, and to open its terminal', () => {
    // Act
    const notice = dialogNotice(watched('f1'));

    // Assert
    should(notice.sessionId).equal('f1');
    should(notice.ref).equal(dialogNoticeRef('aaaaaaaaaaaaaaaa'));
    should(notice.subject).equal('f1-name is waiting on a mcp-servers prompt in Claude Code');
    should(notice.why).equal(
      'f1-name is waiting on a mcp-servers prompt in Claude Code; open its terminal to read and choose.',
    );
    should(notice.howToResolve).containEql('never chooses');
    should(notice.howToResolve).containEql('terminal');
  });

  it('should carry NO pane text: a screen read off a ferret’s state keeps only its id, harness and kind', () => {
    // Arrange: the screen as Ferrets serves it (pane text and all)
    const dialog = WatchedDialogSchema.parse({
      id: 'aaaaaaaaaaaaaaaa',
      harness: 'claude-code',
      kind: 'mcp-servers',
      title: 'New MCP server found in this project',
      body: 'The server docs would run a command.',
      options: [
        { number: 1, label: 'Use this MCP server', grantsTrust: true },
        { number: 2, label: 'Continue without using this MCP server' },
      ],
    });

    // Act
    const everything = JSON.stringify(dialogNotice({ sessionId: 'f1', name: 'ada', dialog }));

    // Assert
    should(Object.keys(dialog).sort()).eql(['harness', 'id', 'kind']);
    for (const paneText of [
      'New MCP server found',
      'The server docs would run a command.',
      'Use this MCP server',
      'Continue without using this MCP server',
      'trusts something',
    ])
      should(everything).not.containEql(paneText);
  });

  it('should carry NO field of a permission prompt: a secret-shaped command is in no notice field', () => {
    // Arrange: a tool prompt whose command holds a bearer token
    const secret = 'Authorization: Bearer abc123SECRETtoken456';
    const dialog = permissionAsDialog({
      id: 'bbbbbbbbbbbbbbbb',
      harness: 'claude-code',
      tool: 'Bash',
      action: 'run',
      what: `curl -H "${secret}" https://example.test/x`,
      question: `Do you want to run curl with ${secret}?`,
      options: [
        { number: 1, label: `Yes, and don't ask again for ${secret}` },
        { number: 2, label: 'No' },
      ],
    }) as WatchedDialogWords;

    // Act
    const notice = dialogNotice({ sessionId: 'f1', name: 'ada', dialog });

    // Assert: nothing of the pane, in any field
    const everything = JSON.stringify(notice);
    for (const leaked of ['abc123', 'Bearer', 'curl', 'example.test', 'Bash', "don't ask again", 'Do you want'])
      should(everything).not.containEql(leaked);
    should(notice.subject).equal('ada is waiting on a permission prompt in Claude Code');
  });

  it('should name Codex, and read a dialog with no harness', () => {
    // Act
    const notice = dialogNotice(watched('f2', { harness: 'codex' }));
    const unnamed = dialogNotice(watched('f3', { harness: undefined }));

    // Assert
    should(notice.subject).containEql('in Codex');
    should(unnamed.subject).containEql('in its harness');
  });

  it('should not let a kind that is not a plain slug into the notice', () => {
    // Act
    const notice = dialogNotice(watched('f4', { kind: 'Bearer abc123 \n rm -rf /' }));

    // Assert
    should(JSON.stringify(notice)).not.containEql('abc123');
    should(notice.subject).containEql('other prompt');
  });

  it('should read a tool-permission prompt as a dialog of kind permission with NONE of its words, and refuse what is not one', () => {
    // Act
    const read = permissionAsDialog({
      id: 'bbbbbbbbbbbbbbbb',
      harness: 'claude-code',
      tool: 'Bash',
      action: 'run',
      what: 'rm -rf build',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes' },
        { number: 2, label: 'No' },
      ],
    });
    const bare = permissionAsDialog({ id: 'cccccccccccccccc', tool: 'Edit', question: 'Make this edit?' });

    // Assert
    should(read).eql({ id: 'bbbbbbbbbbbbbbbb', harness: 'claude-code', kind: 'permission' });
    should(bare).eql({ id: 'cccccccccccccccc', kind: 'permission' });
    should(
      JSON.stringify(dialogNotice({ sessionId: 'f1', name: 'ada', dialog: read as WatchedDialogWords })),
    ).not.containEql('rm -rf build');
    should(permissionAsDialog({ nope: 1 })).equal(undefined);
    should(permissionAsDialog(undefined)).equal(undefined);
  });
});

describe('planning one look', () => {
  it('should raise a dialog never told about, once per ferret', () => {
    // Act
    const plan = planDialogNotices({ dialogs: [watched('f1'), watched('f2')], memory: {} });

    // Assert
    should(plan.raise.map(each => each.sessionId)).eql(['f1', 'f2']);
    should(plan.clear).eql([]);
  });

  it('should raise nothing for the same dialog on the same ferret, however many looks see it', () => {
    // Act
    const plan = planDialogNotices({ dialogs: [watched('f1')], memory: { f1: ['aaaaaaaaaaaaaaaa', '1'] } });

    // Assert
    should(plan.raise).eql([]);
    should(plan.clear).eql([]);
    should(plan.next).eql({ f1: ['aaaaaaaaaaaaaaaa', '0'] });
  });

  it('should leave the usage-limit dialog to the auto-move', () => {
    // Act
    const plan = planDialogNotices({ dialogs: [watched('f1', { kind: 'usage-limit' })], memory: {} });

    // Assert
    should(plan.raise).eql([]);
  });

  it('should close the old notice and raise the new one when ANOTHER dialog stands on the ferret', () => {
    // Act
    const plan = planDialogNotices({
      dialogs: [watched('f1', { id: 'dddddddddddddddd' })],
      memory: { f1: ['aaaaaaaaaaaaaaaa', '0'] },
    });

    // Assert
    should(plan.clear).eql([{ sessionId: 'f1', dialogId: 'aaaaaaaaaaaaaaaa' }]);
    should(plan.raise.map(each => each.dialog.id)).eql(['dddddddddddddddd']);
  });

  it('should keep the episode through a look that misses the dialog, and end it on the next miss', () => {
    // Act
    const first = planDialogNotices({ dialogs: [], memory: { f1: ['aaaaaaaaaaaaaaaa', '0'] } });
    const last = planDialogNotices({ dialogs: [], memory: { f1: ['aaaaaaaaaaaaaaaa', String(GONE_LOOKS - 1)] } });

    // Assert
    should(first.clear).eql([]);
    should(first.next).eql({ f1: ['aaaaaaaaaaaaaaaa', '1'] });
    should(last.clear).eql([{ sessionId: 'f1', dialogId: 'aaaaaaaaaaaaaaaa' }]);
    should(last.next).eql({});
  });

  it('should drop a memory entry that holds no dialog and read a missing miss count as none', () => {
    // Act
    const plan = planDialogNotices({ dialogs: [], memory: { f1: [], f2: ['eeeeeeeeeeeeeeee'] } });

    // Assert
    should(plan.next).eql({ f2: ['eeeeeeeeeeeeeeee', '1'] });
  });
});

describe('the dialog watch', () => {
  it('should raise ONE notice per ferret per dialog episode across many looks', async () => {
    // Arrange
    const { watch, state, log } = stand();
    state.dialogs = [watched('f1'), watched('f2', { id: 'ffffffffffffffff' })];

    // Act
    for (let look = 0; look < 5; look += 1) await watch.look(true);

    // Assert
    should(log.raised.map(notice => notice.sessionId)).eql(['f1', 'f2']);
    should(log.events.filter(type => type === 'fleet.warden_dialog_raised')).have.length(2);
  });

  it('should not raise again after the owner closes the notice while the same dialog stands', async () => {
    // Arrange: the notice port itself reports `unchanged` for a notice that stands or was closed
    const { watch, state, log } = stand({ f1: ['aaaaaaaaaaaaaaaa', '0'] });
    state.dialogs = [watched('f1')];

    // Act
    await watch.look(true);

    // Assert
    should(log.raised).eql([]);
  });

  it('should close the notice when the dialog is gone for good, and raise a new one when it comes back', async () => {
    // Arrange
    const { watch, state, log } = stand();
    state.dialogs = [watched('f1')];
    await watch.look(true);
    state.dialogs = [];

    // Act: gone for GONE_LOOKS looks, then back
    for (let look = 0; look < GONE_LOOKS; look += 1) await watch.look(true);
    state.dialogs = [watched('f1')];
    await watch.look(true);

    // Assert
    should(log.cleared).eql([`f1|${dialogNoticeRef('aaaaaaaaaaaaaaaa')}`]);
    should(log.raised).have.length(2);
  });

  it('should try again next look when the agenda refused the notice, and record it', async () => {
    // Arrange
    const { watch, state, log, memory } = stand();
    state.dialogs = [watched('f1')];
    state.refuse = true;

    // Act
    await watch.look(true);
    const remembered = memory();
    state.refuse = false;
    await watch.look(true);

    // Assert
    should(remembered).eql({});
    should(log.events).containEql('fleet.warden_dialog_notice_failed');
    should(log.raised).have.length(1);
  });

  it('should start or end nothing when the fleet cannot be read', async () => {
    // Arrange
    const { watch, state, log } = stand({ f1: ['aaaaaaaaaaaaaaaa', '0'] });
    state.unreadable = true;

    // Act
    const plan = await watch.look(true);

    // Assert
    should(plan).equal(undefined);
    should(log.cleared).eql([]);
    should(log.events).eql(['fleet.warden_dialog_unreadable']);
  });

  it('should raise nothing and close what stands while the Warden is off', async () => {
    // Arrange
    const { watch, state, log } = stand({ f1: ['aaaaaaaaaaaaaaaa', String(GONE_LOOKS - 1)] });
    state.dialogs = [watched('f1')];

    // Act
    await watch.look(false);

    // Assert
    should(log.raised).eql([]);
    should(log.cleared).eql([`f1|${dialogNoticeRef('aaaaaaaaaaaaaaaa')}`]);
  });
});

const fleetOf = (...sessions: readonly Partial<WardenFleetSession>[]) =>
  sessions.map(
    (session, index) =>
      ({
        config: { id: `f${index}`, mode: 'auto', ...session.config },
        state: { status: 'running', ...session.state },
        hasLiveMonitor: true,
      }) as unknown as WardenFleetSession,
  );

describe('reading the ferrets that are parked on a dialog', () => {
  const dialog = { ...words(), harness: 'claude-code' };
  const prompts: Record<string, unknown> = {
    f0: { dialog },
    f1: { permissionRequest: { id: 'bbbbbbbbbbbbbbbb', tool: 'Bash', question: 'Do you want to proceed?' } },
    f2: { dialog },
    f3: { dialog },
    f4: {},
    f5: { dialog: { nonsense: true } },
    f6: 'throws',
  };
  const ferrets = {
    prompt: async (id: string) => {
      const prompt = prompts[id];
      if (prompt === 'throws') throw new Error('unreadable');
      return prompt;
    },
  } as unknown as Pick<FerretsApi, 'prompt'>;

  it('should read a screen, a tool prompt, and skip a finished, a warden’s, a quiet, a garbled and an unreadable ferret', async () => {
    // Arrange
    const fleet = fleetOf(
      { config: { teammate: 'ada' } as WardenFleetSession['config'] },
      { config: { label: 'review' } as WardenFleetSession['config'] },
      { state: { status: 'completed' } as WardenFleetSession['state'] },
      { config: { label: 'fleet-warden' } as WardenFleetSession['config'] },
      {},
      {},
      {},
    );

    // Act
    const found = await ferretDialogs(ferrets, async () => fleet);

    // Assert
    should(found.map(each => [each.sessionId, each.name, each.dialog.kind])).eql([
      ['f0', 'ada', 'mcp-servers'],
      ['f1', 'review', 'permission'],
    ]);
  });

  it('should carry the REGISTERED family of each ferret (none for a key the family table has no row for)', async () => {
    // Arrange
    const fleet = fleetOf(
      { config: { harness: 'claude' } as WardenFleetSession['config'] },
      { config: { harness: 'codex' } as WardenFleetSession['config'] },
      {},
    );

    // Act
    const found = await ferretDialogs(ferrets, async () => fleet);

    // Assert
    should(found.map(each => each.harness)).eql(['claude', 'codex', undefined]);
  });

  it('should read none from a Ferrets that offers no prompt read', async () => {
    // Act
    const found = await ferretDialogs({} as Pick<FerretsApi, 'prompt'>, async () => fleetOf({}));

    // Assert
    should(found).eql([]);
  });
});

describe('the dialog notice over the Warden agenda', () => {
  it('should raise one plain notice on the ferret’s own board, leave a standing one alone, and close it with its episode', async () => {
    // Arrange
    const asks = new FakeAsks();
    const agenda = new AsksWardenAgenda(asks, new NoticeEntries());
    const port = agendaDialogNotices(agenda);
    const notice = dialogNotice(watched('f1'));

    // Act
    const first = await port.raise(notice);
    const again = await port.raise(notice);
    const standing = (await agenda.board('f1'))?.items.map(item => item.sourceRef);
    await port.clear('f1', notice.ref);
    const after = (await agenda.board('f1'))?.items;

    // Assert
    should(first).equal('created');
    should(again).equal('unchanged');
    should(standing).eql([notice.ref]);
    should(after).eql([]);
  });
});
