import { implementCli, type TerminalIo, type VerbHandler, type VerbInvocation } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { BoardController } from './lib/board-controller.ts';
import { checkMergeGate } from './lib/merge-gate.ts';
import { extrasOf, filesOf, ownFerretOf } from './lib/context.ts';
import { CliInputError } from './lib/errors.ts';
import { ClientBoardGateway, ClientLaneGateway } from './lib/gateway.ts';
import { list, listOrUndefined, on, text, wantsJson } from './lib/invocation.ts';
import { LaneController } from './lib/lane-controller.ts';
import type { BoardOutput } from './lib/ports.ts';
import { RelatedCheck } from './lib/related.ts';

/** The binary name the help texts quote; the shell single-sources it (`packages/cli/package.json` `bin`). */
const BINARY = 'fy';

const outputOf = (io: TerminalIo): BoardOutput => ({
  success: message => io.out(`${message}\n`),
  diagnostic: message => io.err(`${message}\n`),
});

/** A verb whose own refusal (`refuse(...)`) is printed and exits 1; every other failure is the shell's to print. */
const guarded =
  (io: TerminalIo, work: (invocation: VerbInvocation) => Promise<unknown>): VerbHandler =>
  async invocation => {
    try {
      const result = await work(invocation);
      return typeof result === 'number' ? result : 0;
    } catch (error) {
      if (error instanceof CliInputError) {
        io.err(`${error.message}\n`);
        return 1;
      }
      throw error;
    }
  };

/** Words after the first positional (the card id): `card block F12 waiting on infra`. */
const rest = (invocation: VerbInvocation): readonly string[] => invocation.args.slice(1);
const first = (invocation: VerbInvocation): string => invocation.args[0] ?? '';

/**
 * Board's CLI half: `fy board …` and `fy card …`. A card never asks (#1552), so there is no answer verb; `card
 * progress` writes the progress, and the agenda is where the owner is asked.
 */
export default implementCli(manifest, {
  build: context => {
    const { client, io } = context;
    const extras = extrasOf(context, io);
    const output = outputOf(io);
    const gateway = new ClientBoardGateway(client);
    const lanes = new LaneController(new ClientLaneGateway(client), output, BINARY);
    const own = ownFerretOf(extras);
    const board = new BoardController({
      gateway,
      output,
      files: filesOf(extras),
      binary: BINARY,
      ownFerret: own,
      related: new RelatedCheck(gateway, output, own),
    });
    const verb = (work: (invocation: VerbInvocation) => Promise<unknown>): VerbHandler => guarded(io, work);
    const json = wantsJson;
    const target = (invocation: VerbInvocation) => ({ project: text(invocation, 'project'), json: json(invocation) });
    const withJson = (invocation: VerbInvocation) => ({ json: json(invocation) });
    const withReason = (invocation: VerbInvocation) => ({ json: json(invocation), reason: text(invocation, 'reason') });

    return {
      verbs: {
        board: verb(async invocation => {
          await board.board({
            project: text(invocation, 'project'),
            ferret: text(invocation, 'ferret'),
            mine: on(invocation, 'mine'),
            kind: text(invocation, 'kind'),
            pr: text(invocation, 'pr'),
            activity: text(invocation, 'activity'),
            state: text(invocation, 'state'),
            closed: on(invocation, 'closed'),
            private: on(invocation, 'private'),
            all: on(invocation, 'all'),
            query: text(invocation, 'query'),
            json: json(invocation),
            md: on(invocation, 'md'),
          });
        }),
        'board status': verb(async invocation => {
          await lanes.status(target(invocation));
        }),
        'board lanes propose': verb(async invocation => {
          await lanes.propose(target(invocation), {
            template: text(invocation, 'template'),
            rename: list(invocation, 'rename'),
          });
        }),
        'board lanes show': verb(async invocation => {
          await lanes.show(target(invocation));
        }),
        'board lanes edit': verb(async invocation => {
          await lanes.edit(target(invocation), {
            rename: list(invocation, 'rename'),
            remove: list(invocation, 'remove'),
            into: text(invocation, 'into'),
          });
        }),
        'board workflow show': verb(async invocation => {
          await lanes.workflow(target(invocation));
        }),
        'board workflow edit': verb(async invocation => {
          await lanes.editWorkflow(target(invocation), {
            lane: text(invocation, 'lane'),
            gate: list(invocation, 'gate'),
            auto: text(invocation, 'auto'),
          });
        }),

        'card new': verb(async invocation => {
          await board.create(invocation.args, {
            kind: text(invocation, 'kind') ?? text(invocation, 'k'),
            title: text(invocation, 'title') ?? text(invocation, 't'),
            summary: text(invocation, 'summary'),
            ask: text(invocation, 'ask'),
            askSource: text(invocation, 'askSource'),
            premise: listOrUndefined(invocation, 'premise'),
            context: listOrUndefined(invocation, 'context'),
            term: list(invocation, 'term'),
            brief: text(invocation, 'brief'),
            briefFile: text(invocation, 'briefFile'),
            howToTest: text(invocation, 'howToTest'),
            howToTestFile: text(invocation, 'howToTestFile'),
            workflow: text(invocation, 'workflow'),
            dependsOn: list(invocation, 'dependsOn'),
            parent: text(invocation, 'parent'),
            approval: text(invocation, 'approval'),
            thread: text(invocation, 'thread'),
            assignee: text(invocation, 'assignee'),
            project: text(invocation, 'project'),
            lane: text(invocation, 'lane'),
            file: list(invocation, 'file'),
            pr: list(invocation, 'pr'),
            branch: text(invocation, 'branch'),
            doc: list(invocation, 'doc'),
            related: text(invocation, 'related'),
            new: on(invocation, 'new'),
            private: on(invocation, 'private'),
            public: on(invocation, 'public'),
            broad: text(invocation, 'broad'),
            json: json(invocation),
          });
        }),
        'card show': verb(async invocation => {
          await board.show(first(invocation), { json: json(invocation), yaml: on(invocation, 'yaml') });
        }),
        'card move': verb(async invocation => {
          await board.move(first(invocation), invocation.args[1] ?? '', withReason(invocation));
        }),
        'card progress': verb(async invocation => {
          await board.progress(first(invocation), {
            now: text(invocation, 'now'),
            done: text(invocation, 'done'),
            next: text(invocation, 'next'),
            file: text(invocation, 'file'),
            json: json(invocation),
          });
        }),
        'card trigger': verb(async invocation => {
          await board.trigger(first(invocation), invocation.args[1] ?? '', withReason(invocation));
        }),
        'card focus': verb(async invocation => {
          await board.focus(first(invocation), withJson(invocation));
        }),
        'card skip': verb(async invocation => {
          await board.skip(invocation.args, withJson(invocation));
        }),
        'card block': verb(async invocation => {
          await board.block(first(invocation), rest(invocation), withJson(invocation));
        }),
        'card unblock': verb(async invocation => {
          await board.unblock(first(invocation), withReason(invocation));
        }),
        'card depend': verb(async invocation => {
          await board.depend(first(invocation), invocation.args[1] ?? '', {
            json: json(invocation),
            until: text(invocation, 'until'),
            override: text(invocation, 'override'),
          });
        }),
        'card undepend': verb(async invocation => {
          await board.undepend(first(invocation), invocation.args[1] ?? '', withReason(invocation));
        }),
        'card drop': verb(async invocation => {
          await board.drop(first(invocation), withReason(invocation));
        }),
        'card reopen': verb(async invocation => {
          await board.reopen(first(invocation), {
            json: json(invocation),
            to: text(invocation, 'to'),
            ask: text(invocation, 'ask'),
            source: text(invocation, 'source'),
            reason: text(invocation, 'reason'),
          });
        }),
        'card clarify': verb(async invocation => {
          await board.clarify(first(invocation), rest(invocation), {
            json: json(invocation),
            source: text(invocation, 'source'),
          });
        }),
        'card link': verb(async invocation => {
          await board.link(first(invocation), {
            json: json(invocation),
            pr: text(invocation, 'pr'),
            branch: text(invocation, 'branch'),
            commit: text(invocation, 'commit'),
            doc: text(invocation, 'doc'),
          });
        }),
        'card assign': verb(async invocation => {
          await board.assign(first(invocation), invocation.args[1], {
            json: json(invocation),
            none: on(invocation, 'none'),
          });
        }),
        'card claim': verb(async invocation => {
          await board.claim(first(invocation), withJson(invocation));
        }),
        'card adopt': verb(async invocation => {
          await board.adopt(first(invocation), withReason(invocation));
        }),
        'card note': verb(async invocation => {
          await board.note(first(invocation), rest(invocation), withJson(invocation));
        }),
        'card order': verb(async invocation => {
          await board.order(first(invocation), invocation.args[1], {
            json: json(invocation),
            none: on(invocation, 'none'),
          });
        }),
        'card reparent': verb(async invocation => {
          await board.reparent(first(invocation), {
            json: json(invocation),
            parent: text(invocation, 'parent'),
            none: on(invocation, 'none'),
            reason: text(invocation, 'reason'),
          });
        }),
        'card file': verb(async invocation => {
          await board.file(first(invocation), invocation.args[1] ?? '', {
            json: json(invocation),
            remove: on(invocation, 'remove'),
            reason: text(invocation, 'reason'),
          });
        }),
        'card merge-gate': verb(
          async invocation =>
            await checkMergeGate(
              async pr => await gateway.mergeGate(pr),
              { report: message => io.out(`${message}\n`), diagnostic: message => io.err(`${message}\n`) },
              first(invocation),
            ),
        ),
        'card edit': verb(async invocation => {
          await board.edit(first(invocation), {
            json: json(invocation),
            title: text(invocation, 'title'),
            summary: text(invocation, 'summary'),
            premise: listOrUndefined(invocation, 'premise'),
            context: listOrUndefined(invocation, 'context'),
            term: list(invocation, 'term'),
            brief: text(invocation, 'brief'),
            briefFile: text(invocation, 'briefFile'),
            howToTest: text(invocation, 'howToTest'),
            howToTestFile: text(invocation, 'howToTestFile'),
            visibility: text(invocation, 'visibility'),
          });
        }),
        'card patch': verb(async invocation => {
          await board.patch(first(invocation), {
            json: json(invocation),
            file: text(invocation, 'file') ?? text(invocation, 'f'),
          });
        }),
        'card refile': verb(async invocation => {
          await board.refile(first(invocation), {
            json: json(invocation),
            project: text(invocation, 'project'),
            lane: text(invocation, 'lane'),
            reason: text(invocation, 'reason'),
          });
        }),
        // The owner's switch (V-0091, V-0092).
        'board on': verb(async invocation => {
          await lanes.turn(target(invocation), true);
        }),
        'board off': verb(async invocation => {
          await lanes.turn(target(invocation), false);
        }),
      },
    };
  },
});
