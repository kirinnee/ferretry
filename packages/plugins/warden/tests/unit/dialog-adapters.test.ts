import { describe, it } from 'bun:test';
import should from 'should';
import { CLAUDE_DIALOG_RULES, CODEX_DIALOG_RULES } from '../support/dialog-rules.ts';
import type { FerretHarness, FerretsApi, FormKey } from '@ferretry/core-ferrets/contract';
import {
  ApiError,
  type CallContext,
  type ConfigPort,
  type ConfigWriteOutcome,
  type StatePort,
} from '@ferretry/kernel/contract';
import { type DialogRule, DialogProposalSchema, WARDEN_DIALOG_RULES } from '../../contract/dialog-rules.ts';
import { agendaDialogNotices } from '../../daemon/dialogs.ts';
import { dialogRulesInEffect, ferretClearPane } from '../../daemon/dialog-clear.ts';
import { dialogLearnService, dialogRulesView } from '../../daemon/dialog-learn.ts';
import { wardenRoutes } from '../../daemon/routes.ts';
import type { WardenDialogs, WardenSubsystem } from '../../daemon/subsystem.ts';
import { DialogLearnRefused, isTeachable, type DialogNotice, teachSentence } from '../../daemon/lib/index.ts';
import { WardenConfigMoved, WardenConfigRefused } from '../../daemon/adapters/index.ts';

/** The adapters under the dialog clearer and the teaching flow: Ferrets' form seam, the config writer, the routes, the card's words. */

const TAUGHT: DialogRule = {
  id: 'learned-x',
  harness: 'codex',
  kind: 'other',
  title: '^x',
  action: { press: 'escape' },
};

const BUILT_IN = { rules: () => [...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES] };

describe('the rules in effect', () => {
  it('should be the built-in tables, then the ones the owner taught, and only the built-ins while none is taught', async () => {
    // Act
    const taught = await dialogRulesInEffect(
      { file: () => ({ rules: [TAUGHT] }) } as unknown as Pick<ConfigPort, 'file'>,
      BUILT_IN,
    )();
    const bare = await dialogRulesInEffect(
      { file: () => undefined } as unknown as Pick<ConfigPort, 'file'>,
      BUILT_IN,
    )();

    // Assert
    should(bare).eql([...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES]);
    should(taught.at(-1)).eql(TAUGHT);
    should(taught).have.length(bare.length + 1);
  });
});

/** A ferret's form seam: what a capture answers, and every key pressed. */
function formOf(options: { capture?: unknown; key?: boolean } = {}) {
  const pressed: FormKey[] = [];
  const harness = {
    form: {
      capture: async () => options.capture ?? { ok: true, value: { visible: 'the screen', blocking: 'dialog' } },
      key: async (key: FormKey) => {
        pressed.push(key);
        return options.key === false ? { ok: false, error: { refused: 'held' } } : { ok: true, value: undefined };
      },
    },
  } as unknown as FerretHarness;
  return { pressed, ferrets: { harness: async () => harness } as unknown as Pick<FerretsApi, 'harness'> };
}

describe('a ferret’s own pane', () => {
  it('should read the visible frame and say whether the runner sees a dialog or prompt blocking it', async () => {
    // Arrange
    const shown = ferretClearPane(formOf().ferrets);
    const open = ferretClearPane(
      formOf({ capture: { ok: true, value: { visible: 'prompt', blocking: undefined } } }).ferrets,
    );

    // Assert
    should(await shown.frame('f1')).eql({ visible: 'the screen', blocking: 'dialog' });
    should(await open.frame('f1')).eql({ visible: 'prompt', blocking: false });
  });

  it('should type the nudge, else queue it, and never reject', async () => {
    // Arrange
    const typed: string[] = [];
    const queued: string[] = [];
    const seam = (deliverOk: boolean) =>
      ({
        harness: async () => ({
          deliver: async ({ text }: { text: string }) => {
            typed.push(text);
            return { ok: deliverOk };
          },
          queue: async (text: string) => {
            queued.push(text);
            return { ok: true };
          },
        }),
      }) as unknown as Pick<FerretsApi, 'harness'>;
    const settle = async () => await new Promise(resolve => setTimeout(resolve, 5));

    // Act
    ferretClearPane(seam(true)).nudge('f1', 'one');
    await settle();
    ferretClearPane(seam(false)).nudge('f1', 'two');
    await settle();
    const rejects = { harness: async () => Promise.reject(new Error('gone')) } as unknown as Pick<
      FerretsApi,
      'harness'
    >;
    ferretClearPane(rejects).nudge('f1', 'three');
    await settle();

    // Assert
    should(typed).eql(['one', 'two']);
    should(queued).eql(['two']);
  });

  it('should answer nothing for a refused or failed read, and for a ferret with no harness seam', async () => {
    // Assert
    should(
      await ferretClearPane(formOf({ capture: { ok: false, error: { refused: 'no_pane' } } }).ferrets).frame('f1'),
    ).equal(undefined);
    const throws = {
      harness: async () => ({
        form: {
          capture: async () => Promise.reject(new Error('gone')),
          key: async () => Promise.reject(new Error('gone')),
        },
      }),
    };
    should(await ferretClearPane(throws as unknown as Pick<FerretsApi, 'harness'>).frame('f1')).equal(undefined);
    should(
      await ferretClearPane(throws as unknown as Pick<FerretsApi, 'harness'>).key('f1', 'Enter', () => true),
    ).equal(false);
    const none = ferretClearPane({} as Pick<FerretsApi, 'harness'>);
    should(await none.frame('f1')).equal(undefined);
    should(await none.key('f1', 'Enter', () => true)).equal(false);
  });

  it('should press a key through the form, and say false when the runner refuses it', async () => {
    // Arrange
    const ok = formOf();
    const refused = formOf({ key: false });

    // Assert
    should(await ferretClearPane(ok.ferrets).key('f1', 'Escape', () => true)).equal(true);
    should(ok.pressed).eql(['Escape']);
    should(await ferretClearPane(refused.ferrets).key('f1', 'Escape', () => true)).equal(false);
  });

  it('should re-read the pane at the write, and press nothing unless the frame it reads passes the guard', async () => {
    // Arrange
    const guarded = formOf();
    const seen: unknown[] = [];

    // Act
    const declined = await ferretClearPane(guarded.ferrets).key('f1', 'Escape', frame => {
      seen.push(frame);
      return false;
    });

    // Assert
    should(declined).equal(false);
    should(guarded.pressed).eql([]);
    should(seen).eql([{ visible: 'the screen', blocking: 'dialog' }]);
  });

  it('should press nothing when the write-time read fails', async () => {
    // Arrange
    const blind = formOf({ capture: { ok: false, error: { refused: 'no_pane' } } });

    // Assert
    should(await ferretClearPane(blind.ferrets).key('f1', 'Escape', () => true)).equal(false);
    should(blind.pressed).eql([]);
  });
});

/** The teaching flow's ports: Ferrets, the config writer (answering what the test says), the state, the masker. */
function teachStand(outcome: ConfigWriteOutcome | 'throws' = { kind: 'written', etag: 'e', loosened: [] }) {
  const writes: unknown[] = [];
  const frames: { name: string | undefined; text: unknown }[] = [];
  let members: Record<string, readonly string[]> = {};
  const config = {
    file: () => ({ rules: [{ ...TAUGHT, id: 'learned-old' }, TAUGHT] }),
    write: async (_def: unknown, _name: unknown, edit: unknown) => {
      writes.push(edit);
      if (outcome === 'throws') throw new Error('no');
      return outcome;
    },
  } as unknown as ConfigPort;
  const state = {
    write: async (_def: unknown, text: unknown, name?: string) => {
      frames.push({ name, text });
    },
  } as unknown as StatePort;
  const dialog = {
    id: 'cccccccccccccccc',
    harness: 'claude',
    kind: 'other',
    title: 'LSP plugin recommendation',
    options: [
      { number: 1, label: 'Yes, install', grantsTrust: true },
      { number: 2, label: 'No, not now', grantsTrust: false },
    ],
  };
  const prompts: Record<string, unknown> = {
    'f/1': { dialog },
    perm: { permissionRequest: { id: 'dddddddddddddddd', tool: 'Bash', question: 'Do you want to proceed?' } },
    none: {},
  };
  const { ferrets: pane } = formOf();
  const proposals = {
    read: async () => members,
    write: async (next: Record<string, readonly string[]>) => {
      members = next;
    },
  };
  const service = dialogLearnService({
    ferrets: { ...pane, prompt: async (id: string) => prompts[id] } as unknown as Pick<
      FerretsApi,
      'harness' | 'prompt'
    >,
    config,
    state,
    mask: async text => text,
    proposals,
    record: () => undefined,
  });
  return { service, writes, frames, members: () => members, proposals, config };
}

describe('teaching a screen over the daemon’s ports', () => {
  it('should propose from the ferret’s recorded dialog, keep its frame under a plain name, and save on the yes', async () => {
    // Arrange
    const { service, writes, frames, members } = teachStand();

    // Act
    const proposed = await service.learn('f/1');
    const saved = await service.confirm('f/1');

    // Assert
    should(proposed.proposal.rule?.action).eql({ choose: 'No, not now' });
    should(frames).eql([{ name: 'f_1', text: 'the screen' }]);
    should(saved.saved).equal(true);
    should(members()).eql({});
    const patch = (writes[0] as { patch: { rules: DialogRule[] } }).patch;
    should(patch.rules.map(rule => rule.id)).eql(['learned-old', 'learned-x', proposed.proposal.rule?.id]);
  });

  it('should read a tool prompt as a dialog it will not teach, and refuse a ferret with no dialog', async () => {
    // Arrange
    const { service } = teachStand();

    // Assert
    should((await service.learn('perm')).proposal.note).containEql('never taught');
    await service.learn('none').then(
      () => should.fail(undefined, undefined, 'learned'),
      (error: unknown) => should(error).be.instanceOf(DialogLearnRefused),
    );
  });

  it('should answer what the kernel holds for the owner, and refuse a write the kernel refuses or that raced', async () => {
    // Assert
    const held = teachStand({ kind: 'held', etag: 'e', id: 'x', sentences: ['waits for you'] });
    await held.service.learn('f/1');
    should((await held.service.confirm('f/1')).heldFor).eql(['waits for you']);

    const refused = teachStand({
      kind: 'refused',
      reason: 'schema',
      issues: [{ message: 'bad rule' }],
    } as unknown as ConfigWriteOutcome);
    await refused.service.learn('f/1');
    await refused.service.confirm('f/1').then(
      () => should.fail(undefined, undefined, 'saved'),
      (error: unknown) => should(error).be.instanceOf(WardenConfigRefused),
    );

    const raced = teachStand({ kind: 'conflict' });
    await raced.service.learn('f/1');
    await raced.service.confirm('f/1').then(
      () => should.fail(undefined, undefined, 'saved'),
      (error: unknown) => should(error).be.instanceOf(WardenConfigMoved),
    );
  });

  it('should list the built-in rules, the taught ones and the proposals that wait', async () => {
    // Arrange
    const { service, proposals, config } = teachStand();
    await service.learn('f/1');

    // Act
    const view = await dialogRulesView(config, proposals, BUILT_IN);

    // Assert
    should(view.builtIn.map(rule => rule.id)).containEql('claude-dangerous-rm');
    should(view.builtIn.find(rule => rule.id === 'claude-dangerous-rm')?.does).equal('presses Esc');
    should(view.builtIn.find(rule => rule.id === 'codex-update')?.does).equal('chooses “Skip”');
    should(view.taught.map(rule => rule.id)).eql(['learned-old', 'learned-x']);
    should(view.pending).have.length(1);
    should(DialogProposalSchema.safeParse(view.pending[0]).success).equal(true);
  });

  it('should list no taught rule when the file has none, and skip a proposal it cannot read', async () => {
    // Arrange
    const config = { file: () => undefined } as unknown as ConfigPort;
    const proposals = { read: async () => ({ f1: ['{"nonsense":true}'], f2: [] }), write: async () => undefined };

    // Act
    const view = await dialogRulesView(config, proposals, { rules: () => [] });

    // Assert
    should(view.taught).eql([]);
    should(view.pending).eql([]);
    should(WARDEN_DIALOG_RULES.file).equal('warden-dialogs.yaml');
  });
});

describe('the dialog notice says how to teach Ferretry the screen', () => {
  const notice = (context: string): DialogNotice => ({
    sessionId: 'f1',
    dialogId: 'aaaaaaaaaaaaaaaa',
    ref: 'warden-dialog:aaaaaaaaaaaaaaaa',
    subject: 'ada is stopped',
    why: 'It waits.',
    howToResolve: 'Open the terminal.',
    context,
  });

  async function raised(context: string): Promise<string> {
    let how = '';
    const port = agendaDialogNotices({
      noticeOutcome: async (_session: string, entry: { howToResolve: string }) => {
        how = entry.howToResolve;
        return { write: 'created' };
      },
      resolveSource: async () => undefined,
    } as unknown as Parameters<typeof agendaDialogNotices>[0]);
    await port.raise(notice(context));
    return how;
  }

  it('should add the button and the command to a screen that can be taught, with the ferret’s id and nothing from the pane', async () => {
    // Act
    const how = await raised('Harness dialog (other) seen on ada.');

    // Assert
    should(how).containEql('Look at its screen').and.containEql('fy warden dialog learn f1');
    should(how).equal(`Open the terminal. ${teachSentence('f1')}`);
  });

  it('should say nothing of teaching for a tool prompt or a spent login', async () => {
    // Assert
    should(await raised('Harness dialog (permission) seen on ada.')).equal('Open the terminal.');
    should(await raised('Harness dialog (usage-limit) seen on ada.')).equal('Open the terminal.');
    should(isTeachable('Harness dialog (mcp-servers) seen on ada.')).equal(true);
  });
});

describe('the teaching routes', () => {
  const callOf = (body?: unknown): CallContext =>
    ({
      request: {
        method: 'POST',
        path: '/v1/warden/dialog/learn',
        query: new Map(),
        headers: new Map([['content-type', 'application/json']]),
        text: async () => (body === undefined ? '' : JSON.stringify(body)),
      },
      params: new Map(),
    }) as unknown as CallContext;

  const dialogs = (learn: WardenDialogs['learn']): WardenDialogs => ({
    rules: async () => ({ builtIn: [], taught: [], pending: [] }),
    learn,
  });
  const routesOf = (taught?: WardenDialogs) => wardenRoutes({} as WardenSubsystem, { mayTouch: () => true }, taught);

  it('should answer the rules, and the proposal for a ferret, as the owner’s call', async () => {
    // Arrange
    const asked: unknown[] = [];
    const routes = routesOf(
      dialogs(async request => {
        asked.push(request);
        return { proposal: { ferret: 'ada', title: 't', rows: [], held: false }, saved: false, heldFor: [] };
      }),
    );

    // Act
    const rules = await routes['GET /v1/warden/dialog/rules'](callOf());
    const learned = await routes['POST /v1/warden/dialog/learn'](callOf({ ferret: 'ada', confirm: true, row: 2 }));

    // Assert
    should(JSON.parse(String(rules.body))).eql({ builtIn: [], taught: [], pending: [] });
    should(JSON.parse(String(learned.body)).saved).equal(false);
    should(asked).eql([{ ferret: 'ada', confirm: true, row: 2 }]);
  });

  it('should refuse a screen that cannot be taught with its own sentence (409), a bad body (400), and no service (503)', async () => {
    // Arrange
    const refusing = routesOf(
      dialogs(async () => {
        throw new DialogLearnRefused('that ferret is not parked on a dialog right now.');
      }),
    );

    // Assert
    await refusing['POST /v1/warden/dialog/learn'](callOf({ ferret: 'ada' })).then(
      () => should.fail(undefined, undefined, 'answered'),
      (error: unknown) => {
        should(error).be.instanceOf(ApiError);
        should(error).have.property('status', 409);
        should(error).have.property('code', 'warden_dialog_not_learnable');
      },
    );
    await refusing['POST /v1/warden/dialog/learn'](callOf({ nonsense: 1 })).then(
      () => should.fail(undefined, undefined, 'answered'),
      (error: unknown) => should(error).have.property('status', 400),
    );
    await routesOf()
      ['GET /v1/warden/dialog/rules'](callOf())
      .then(
        () => should.fail(undefined, undefined, 'answered'),
        (error: unknown) => should(error).have.property('status', 503),
      );
  });
});
