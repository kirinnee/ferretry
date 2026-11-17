import { describe, it } from 'bun:test';
import should from 'should';
import { CLAUDE_DIALOG_RULES, CODEX_DIALOG_RULES, DIALOG_NUDGES } from '../support/dialog-rules.ts';
import { type FormKey, RecordedHarnessSchema } from '@ferretry/core-ferrets/contract';
import { DialogRuleSchema, DialogRulesFileSchema, isGrantLabel } from '../../contract/dialog-rules.ts';
import {
  type ClearFrame,
  cursorRow,
  type DialogClearPorts,
  type DialogNotice,
  frameShows,
  planKeys,
  ruleFor,
  WardenDialogClear,
  WardenDialogWatch,
  type WatchedDialog,
  type ClearableDialogWords,
} from '../../daemon/lib/index.ts';

/**
 * O14: a screen a rule knows how to leave is left AT ONCE, with the keys that decline or dismiss it — never one that grants —
 * and journalled once, with no card and no pane text. Every case runs over a FAKE frame: nothing here is a real pane.
 */

const BUILT_IN = [...CLAUDE_DIALOG_RULES, ...CODEX_DIALOG_RULES];

/** One known screen: what Ferrets would have recorded, and how the harness draws it. */
interface Screen {
  readonly rule: string;
  readonly dialog: ClearableDialogWords;
  /** The lines above the rows (a header the frame carries). */
  readonly header: readonly string[];
  /** The glyph the harness draws on the cursor row. */
  readonly glyph: '❯' | '›';
  readonly footer: string;
  /** What to expect pressed when the cursor starts on `start`. */
  readonly start: number;
  readonly keys: readonly FormKey[];
}

const row = (number: number, label: string, grantsTrust = false) => ({ number, label, grantsTrust });
const words = (
  over: Partial<ClearableDialogWords> & Pick<ClearableDialogWords, 'kind' | 'title'>,
): ClearableDialogWords => ({
  id: 'aaaaaaaaaaaaaaaa',
  harness: 'claude',
  options: [],
  ...over,
});

const SCREENS: readonly Screen[] = [
  {
    rule: 'claude-dangerous-rm',
    dialog: words({
      kind: 'permission',
      title: 'Do you want to proceed?',
      body: 'Bash wants to run: rm -rf "$TARGET"',
      options: [row(1, 'Yes'), row(2, 'No')],
    }),
    header: [
      ' Bash command',
      '   rm -rf "$TARGET"',
      ' Dangerous rm operation detected: the target is a variable that may be empty. This requires explicit approval.',
      ' Do you want to proceed?',
    ],
    glyph: '❯',
    footer: ' Esc to cancel · Tab to amend',
    start: 1,
    keys: ['Escape'],
  },
  {
    rule: 'claude-mcp-servers',
    dialog: words({
      kind: 'mcp-servers',
      title: 'New MCP server found in this project: docs',
      options: [
        row(1, 'Use this MCP server', true),
        row(2, 'Use this and all future MCP servers in this project', true),
        row(3, 'Continue without using this MCP server'),
      ],
      escape: 'cancel',
    }),
    header: ['  New MCP server found in this project: docs', '  MCP servers may execute code.'],
    glyph: '❯',
    footer: '  Enter to confirm · Esc to cancel',
    start: 1,
    keys: ['Down', 'Down', 'Enter'],
  },
  {
    rule: 'claude-settings-error',
    dialog: words({
      kind: 'settings-error',
      title: 'Settings Error',
      options: [row(1, 'Fix with Claude'), row(2, 'Exit and fix manually'), row(3, 'Continue without these settings')],
      escape: 'cancel',
    }),
    header: ['  Settings Error', '  /home/dev/.claude/settings.json'],
    glyph: '❯',
    footer: '  Enter to confirm · Esc to cancel',
    start: 3,
    keys: ['Enter'],
  },
  {
    rule: 'claude-lsp-recommendation',
    dialog: words({
      kind: 'other',
      title: 'LSP plugin recommendation',
      options: [
        row(1, 'Yes, install', true),
        row(2, 'No, not now'),
        row(3, 'Never for this plugin'),
        row(4, 'Disable all LSP recommendations'),
      ],
      escape: 'cancel',
    }),
    header: ['  LSP plugin recommendation', '  Would you like to install this LSP plugin?'],
    glyph: '❯',
    footer: '  Enter to confirm · Esc to cancel',
    start: 4,
    keys: ['Up', 'Up', 'Enter'],
  },
  {
    rule: 'codex-hooks-review',
    dialog: words({
      harness: 'codex',
      kind: 'hooks-review',
      title: 'Hooks need review',
      options: [
        row(1, 'Review hooks'),
        row(2, 'Trust all and continue', true),
        row(3, "Continue without trusting (hooks won't run)"),
      ],
      escape: 'skip',
    }),
    header: ['  Hooks need review', '  1 hook is new or changed.'],
    glyph: '›',
    footer: '  enter confirm · esc skip',
    start: 1,
    keys: ['Down', 'Down', 'Enter'],
  },
  {
    rule: 'codex-hooks-list',
    dialog: words({ harness: 'codex', kind: 'hooks-list', title: 'Hooks', escape: 'close' }),
    header: ['  Hooks', '  Lifecycle hooks from config'],
    glyph: '›',
    footer: '  esc close',
    start: 1,
    keys: ['Escape'],
  },
  {
    rule: 'codex-update',
    dialog: words({
      harness: 'codex',
      kind: 'update',
      title: 'Update available · 0.156.1 → 0.999.0',
      options: [
        row(1, 'Update now (runs `npm install -g @openai/codex`)'),
        row(2, 'Skip'),
        row(3, 'Skip until next version'),
      ],
      escape: 'skip',
    }),
    header: ['  Update available · 0.156.1 → 0.999.0'],
    glyph: '›',
    footer: '  enter continue · esc skip',
    start: 1,
    keys: ['Down', 'Enter'],
  },
  {
    rule: 'codex-model-successor',
    dialog: words({
      harness: 'codex',
      kind: 'other',
      title: 'Meet GPT-6 Sol',
      options: [row(1, 'Try new model'), row(2, 'Use existing model')],
      escape: 'confirm',
    }),
    header: ['  Meet GPT-6 Sol', '  Our latest Sol is more efficient.'],
    glyph: '›',
    footer: '  enter/esc confirm · ^c quit',
    start: 1,
    keys: ['Down', 'Enter'],
  },
];

/** The frame a harness draws: the header, the rows (the cursor on one) and the footer. */
function frameOf(screen: Screen, cursor: number): string {
  const rows = screen.dialog.options.map((option, index) =>
    index + 1 === cursor
      ? `  ${screen.glyph} ${screen.glyph === '›' ? `${String(option.number)}. ` : ''}${option.label}`
      : `    ${screen.glyph === '›' ? `${String(option.number)}. ` : ''}${option.label}`,
  );
  return ['', ...screen.header, '', ...rows, '', screen.footer].join('\n');
}

/** What the runner's reader says blocks a screen of this kind. */
const blockingOf = (screen: Screen): 'permission' | 'dialog' =>
  screen.dialog.kind === 'permission' ? 'permission' : 'dialog';

/** A ferret's pane that obeys its keys: arrows move the cursor, Enter and Esc leave the screen (unless it is stuck). */
function fakePane(screen: Screen, options: { readonly stuck?: boolean; readonly refuse?: boolean } = {}) {
  const state = { cursor: screen.start, gone: false, pressed: [] as FormKey[] };
  const ports = {
    words: async (): Promise<ClearableDialogWords | undefined> => screen.dialog,
    frame: async (): Promise<ClearFrame | undefined> =>
      state.gone
        ? { visible: '\n  ❯ \n', blocking: false }
        : { visible: frameOf(screen, state.cursor), blocking: blockingOf(screen) },
    key: async (_session: string, key: FormKey): Promise<boolean> => {
      if (options.refuse === true) return false;
      state.pressed.push(key);
      if (key === 'Down') state.cursor = Math.min(screen.dialog.options.length, state.cursor + 1);
      if (key === 'Up') state.cursor = Math.max(1, state.cursor - 1);
      if ((key === 'Enter' || key === 'Escape') && options.stuck !== true) state.gone = true;
      return true;
    },
  };
  return { state, ports };
}

function stand(pane: Pick<DialogClearPorts, 'frame' | 'key' | 'words'>, rules = BUILT_IN) {
  let memory: Record<string, readonly string[]> = {};
  const events: { type: string; data: Readonly<Record<string, string>> }[] = [];
  const nudges: { sessionId: string; text: string }[] = [];
  const clear = new WardenDialogClear({
    rules: async () => rules,
    nudgeOf: ruleId => DIALOG_NUDGES[ruleId],
    ...pane,
    nudge: (sessionId, text) => {
      nudges.push({ sessionId, text });
    },
    sleep: async () => undefined,
    memory: {
      read: async () => memory,
      write: async next => {
        memory = next;
      },
    },
    record: (type, data) => {
      events.push({ type, data });
    },
  });
  return { clear, events, nudges, memory: () => memory };
}

const watched = (screen: Screen): WatchedDialog => ({ sessionId: 'f1', name: 'ada', dialog: screen.dialog });

describe('every known screen has a rule that leaves it', () => {
  for (const screen of SCREENS) {
    it(`should press ${screen.keys.join(' ')} once on the ${screen.rule} screen, journal it, and tell nobody`, async () => {
      // Arrange
      const { state, ports } = fakePane(screen);
      const { clear, events } = stand(ports);

      // Act
      const first = await clear.clear([watched(screen)]);
      const second = await clear.clear([watched(screen)]);

      // Assert
      should(state.pressed).eql(screen.keys);
      should(first.toTell).eql([]);
      should(first.cleared).equal(1);
      should(second.toTell).eql([]);
      should(events).eql([
        {
          type: 'fleet.warden_dialog_autocleared',
          data: {
            sessionId: 'f1',
            harness: screen.dialog.harness as string,
            kind: screen.dialog.kind,
            rule: screen.rule,
          },
        },
      ]);
    });
  }

  it('should spell its harness the way Ferrets records a ferret’s dialog, or no rule would ever match one', () => {
    // Assert
    for (const rule of BUILT_IN) should(RecordedHarnessSchema.safeParse(rule.harness).success).equal(true);
    for (const screen of SCREENS) should(RecordedHarnessSchema.safeParse(screen.dialog.harness).success).equal(true);
  });

  it('should have a screen under test for every built-in rule', () => {
    // Assert
    should(SCREENS.map(screen => screen.rule).sort()).eql(BUILT_IN.map(rule => rule.id).sort());
  });
});

describe('a rule never grants', () => {
  it('should hold every built-in rule to the schema, and never name a row that reads as a grant', () => {
    for (const rule of BUILT_IN) {
      should(DialogRuleSchema.safeParse(rule).success).equal(true);
      if ('choose' in rule.action) should(isGrantLabel(rule.action.choose)).equal(false);
    }
  });

  it('should plan no row of any known screen that the harness marks as trusting or that reads as a grant', () => {
    for (const screen of SCREENS) {
      const rule = ruleFor(screen.dialog, BUILT_IN);
      should(rule?.id).equal(screen.rule);
      const plan = planKeys(rule as NonNullable<typeof rule>, screen.dialog, frameOf(screen, screen.start));
      should(typeof plan).equal('object');
      if (typeof plan === 'string' || plan.row === undefined) continue;
      const chosen = screen.dialog.options.find(option => option.number === plan.row);
      should(chosen?.grantsTrust).equal(false);
      should(isGrantLabel(chosen?.label ?? '', chosen?.grantsTrust)).equal(false);
    }
  });

  it('should refuse a rule that names a granting row, in a file and in the planner', () => {
    // Arrange
    const grants = [
      'Yes',
      'Trust all and continue',
      'Use this MCP server',
      "Yes, and don't ask again",
      'Always allow',
      'Approve',
    ];

    for (const choose of grants) {
      // Assert
      const file = { rules: [{ id: 'x', harness: 'codex', kind: 'other', title: 'x', action: { choose } }] };
      should(DialogRulesFileSchema.safeParse(file).success).equal(false);
      const screen = SCREENS[1] as Screen;
      const rule = { id: 'x', harness: 'claude', kind: 'mcp-servers', title: '.', action: { choose } } as const;
      const dialog = { ...screen.dialog, options: [row(1, choose), row(2, 'Continue without using this MCP server')] };
      should(planKeys(rule, dialog, frameOf({ ...screen, dialog }, 1))).equal('grants');
    }
  });

  it('should never plan a row the harness marked grantsTrust, whatever its words say', () => {
    // Arrange
    const screen = SCREENS[1] as Screen;
    const dialog = {
      ...screen.dialog,
      options: [row(1, 'Carry on', true), row(2, 'Continue without using this MCP server')],
    };
    const rule = {
      id: 'x',
      harness: 'claude',
      kind: 'mcp-servers',
      title: '.',
      action: { choose: 'Carry on' },
    } as const;

    // Act
    const plan = planKeys(rule, dialog, frameOf({ ...screen, dialog }, 2));

    // Assert
    should(plan).equal('grants');
  });

  it('should refuse a pattern that does not compile, and a rule with no title or fixed line', () => {
    // Assert
    should(
      DialogRuleSchema.safeParse({ id: 'x', harness: 'codex', kind: 'other', title: '(', action: { press: 'escape' } })
        .success,
    ).equal(false);
    should(
      DialogRuleSchema.safeParse({ id: 'x', harness: 'codex', kind: 'other', action: { press: 'escape' } }).success,
    ).equal(false);
  });
});

describe('planning the keys', () => {
  const screen = SCREENS[1] as Screen;
  const rule = BUILT_IN.find(each => each.id === screen.rule) as NonNullable<(typeof BUILT_IN)[number]>;

  it('should plan nothing when there is no Esc, no such row, or the cursor cannot be read', () => {
    // Assert
    const esc = { id: 'x', harness: 'codex', kind: 'other', title: '.', action: { press: 'escape' } } as const;
    should(planKeys(esc, { ...screen.dialog, kind: 'other', escape: undefined }, '')).equal('no-escape');
    should(planKeys({ ...rule, action: { choose: 'Nope' } }, screen.dialog, frameOf(screen, 1))).equal('no-row');
    should(planKeys(rule, screen.dialog, '\n  nothing here\n')).equal('cursor-unknown');
  });

  it('should read the cursor only when exactly one row carries it', () => {
    // Assert
    should(cursorRow(frameOf(screen, 2), screen.dialog)).equal(2);
    should(cursorRow(`${frameOf(screen, 1)}\n  ❯ Continue without using this MCP server`, screen.dialog)).equal(
      undefined,
    );
    should(cursorRow('', screen.dialog)).equal(undefined);
  });

  it('should match a rule only on its harness, kind and title, and read a permission prompt by its tool', () => {
    // Assert
    should(ruleFor({ ...screen.dialog, harness: 'codex' }, BUILT_IN)).equal(undefined);
    should(ruleFor({ ...screen.dialog, title: 'Something else' }, BUILT_IN)).equal(undefined);
    should(ruleFor({ ...screen.dialog, harness: undefined }, BUILT_IN)).equal(undefined);
    const rm = SCREENS[0] as Screen;
    should(ruleFor(rm.dialog, BUILT_IN)?.id).equal('claude-dangerous-rm');
    should(ruleFor({ ...rm.dialog, body: 'Read wants to read: x' }, BUILT_IN)).equal(undefined);
    should(ruleFor({ ...rm.dialog, body: undefined }, BUILT_IN)).equal(undefined);
  });

  it('should find a fixed phrase only on a printed line, not inside a command', () => {
    // Arrange
    const rm = SCREENS[0] as Screen;
    const dangerous = BUILT_IN.find(each => each.id === 'claude-dangerous-rm') as NonNullable<
      (typeof BUILT_IN)[number]
    >;
    const ordinary = ['  Bash command', '  echo "Dangerous rm operation detected"', '  Do you want to proceed?'].join(
      '\n',
    );

    // Assert
    should(frameShows(dangerous, rm.dialog, frameOf(rm, 1))).equal(true);
    should(frameShows(dangerous, rm.dialog, ordinary)).equal(false);
    should(frameShows(rule, screen.dialog, frameOf(screen, 1))).equal(true);
    should(frameShows(rule, screen.dialog, '\n  something else\n')).equal(false);
  });

  it('should treat a pattern that stopped compiling as matching nothing', () => {
    // Assert
    const broken = { ...rule, title: '(' } as unknown as typeof rule;
    should(ruleFor(screen.dialog, [broken])).equal(undefined);
  });
});

describe('what a ferret is told after its prompt was declined', () => {
  it('should nudge the ferret, once and in plain words, after the dangerous-rm Esc — and say nothing after a choice', async () => {
    // Arrange
    const rm = SCREENS[0] as Screen;
    const mcp = SCREENS[1] as Screen;
    const first = stand(fakePane(rm).ports);
    const second = stand(fakePane(mcp).ports);

    // Act
    await first.clear.clear([watched(rm)]);
    await first.clear.clear([watched(rm)]);
    await second.clear.clear([watched(mcp)]);

    // Assert
    should(first.nudges).have.length(1);
    should(first.nudges[0]?.sessionId).equal('f1');
    should(first.nudges[0]?.text).match(/explicit absolute rm paths/u);
    should(second.nudges).eql([]);
  });

  it('should not nudge a ferret whose Esc was never pressed', async () => {
    // Arrange
    const rm = SCREENS[0] as Screen;
    const { ports } = fakePane(rm, { refuse: true });
    const { clear, nudges } = stand(ports);

    // Act
    await clear.clear([watched(rm)]);

    // Assert
    should(nudges).eql([]);
  });
});

describe('when the keys cannot go', () => {
  const screen = SCREENS[1] as Screen;

  it('should press nothing for a recorded dialog the pane no longer shows', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    state.gone = true;
    const { clear } = stand(ports);

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result).eql({ toTell: [], cleared: 0 });
  });

  it('should press nothing when the runner reads no dialog or prompt on the frame', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    const { clear } = stand({ ...ports, frame: async () => ({ visible: frameOf(screen, 1), blocking: false }) });

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.toTell).eql([]);
  });

  it('should press nothing when the record says a dialog but the live frame is a permission prompt with spoofed lines', async () => {
    // Arrange: a Bash permission prompt whose command text holds the recorded title and a row-3 look-alike line.
    const { state, ports } = fakePane(screen);
    const spoofed = [
      ' Bash command',
      '   echo "New MCP server found in this project: docs"',
      '   ❯ 3. Continue without using this MCP server',
      ' Do you want to proceed?',
      '',
      '   ❯ 1. Yes',
      '     2. No',
    ].join('\n');
    const { clear, events } = stand({ ...ports, frame: async () => ({ visible: spoofed, blocking: 'permission' }) });

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.cleared).equal(0);
    should(events.map(event => event.type)).eql([]);
  });

  it('should press nothing for a permission rule when the live frame is a dialog, not a permission prompt', async () => {
    // Arrange
    const rm = SCREENS[0] as Screen;
    const { state, ports } = fakePane(rm);
    const { clear } = stand({ ...ports, frame: async () => ({ visible: frameOf(rm, 1), blocking: 'dialog' }) });

    // Act
    const result = await clear.clear([watched(rm)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.cleared).equal(0);
  });

  it('should hand the dialog to the notice when a key is refused, and press no more', async () => {
    // Arrange
    const { state, ports } = fakePane(screen, { refuse: true });
    const { clear, events } = stand(ports);

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.toTell.map(each => each.sessionId)).eql(['f1']);
    should(events.map(event => event.type)).eql([]);
  });

  it('should not press Enter when the cursor never reached the chosen row', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    const { clear } = stand({ ...ports, frame: async () => ({ visible: frameOf(screen, 1), blocking: 'dialog' }) });

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).not.containEql('Enter');
    should(result.toTell).have.length(1);
  });

  it('should hand a screen back, with no keys, when the plan has no row to press', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    const { clear, events } = stand({
      ...ports,
      frame: async () => ({ visible: '\n  New MCP server found in this project: docs\n', blocking: 'dialog' }),
    });

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.toTell).have.length(1);
    should(events.map(event => event.type)).eql(['fleet.warden_dialog_clear_skipped']);
  });

  it('should tell the dialog to the owner ONCE when the keys went and the screen is still up', async () => {
    // Arrange
    const { state, ports } = fakePane(screen, { stuck: true });
    const { clear, events } = stand(ports);

    // Act
    const first = await clear.clear([watched(screen)]);
    const second = await clear.clear([watched(screen)]);
    const third = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql(['Down', 'Down', 'Enter']);
    should(first.toTell).eql([]);
    should(second.toTell).have.length(1);
    should(third.toTell).have.length(1);
    should(events.map(event => event.type)).eql([
      'fleet.warden_dialog_autocleared',
      'fleet.warden_dialog_clear_failed',
    ]);
  });

  it('should leave a dialog no rule names to the notice, untouched', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    const { clear } = stand(ports, []);

    // Act
    const result = await clear.clear([watched(screen)]);

    // Assert
    should(state.pressed).eql([]);
    should(result.toTell).have.length(1);
  });

  it('should key the same screen again when it comes back after it left', async () => {
    // Arrange
    const { state, ports } = fakePane(screen);
    const { clear } = stand(ports);
    await clear.clear([watched(screen)]);
    await clear.clear([]);
    state.gone = false;
    state.cursor = screen.start;

    // Act
    const again = await clear.clear([watched(screen)]);

    // Assert
    should(again.cleared).equal(1);
    should(state.pressed).have.length(6);
  });
});

describe('the dialog watch with a clearer', () => {
  it('should raise no notice for a screen a rule cleared, and one notice when the keys failed', async () => {
    // Arrange
    const screen = SCREENS[1] as Screen;
    const { ports } = fakePane(screen, { stuck: true });
    const { clear } = stand(ports);
    const raised: DialogNotice[] = [];
    let memory: Record<string, readonly string[]> = {};
    const watch = new WardenDialogWatch({
      dialogs: async () => [watched(screen)],
      memory: {
        read: async () => memory,
        write: async next => {
          memory = next;
        },
      },
      notices: {
        raise: async notice => {
          raised.push(notice);
          return 'created';
        },
        clear: async () => undefined,
      },
      clear,
      record: () => undefined,
    });

    // Act
    await watch.look(true);
    const quiet = raised.length;
    await watch.look(true);
    await watch.look(true);

    // Assert
    should(quiet).equal(0);
    should(raised).have.length(1);
  });

  it('should not clear anything while the Warden is off, and survive a clearer that throws', async () => {
    // Arrange
    const screen = SCREENS[1] as Screen;
    const { state, ports } = fakePane(screen);
    const { clear } = stand(ports);
    const events: string[] = [];
    const build = (clearer: {
      clear(dialogs: readonly WatchedDialog[]): Promise<{ readonly toTell: readonly WatchedDialog[] }>;
    }) =>
      new WardenDialogWatch({
        dialogs: async () => [watched(screen)],
        memory: { read: async () => ({}), write: async () => undefined },
        notices: { raise: async () => 'created', clear: async () => undefined },
        clear: clearer,
        record: type => {
          events.push(type);
        },
      });

    // Act
    await build(clear).look(false);
    const plan = await build({
      clear: async () => {
        throw new Error('no pane');
      },
    }).look(true);

    // Assert
    should(state.pressed).eql([]);
    should(events).containEql('fleet.warden_dialog_clear_unavailable');
    should(plan?.raise).have.length(1);
  });
});
