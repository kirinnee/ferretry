import { implementCli } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { ambientTmuxEnvironment, BunTmuxAttachProcess, ExactTmuxAttacher } from './adapters/attach/tmux-attacher.ts';
import { TerminalToolsClient } from './lib/agent-tools/client.ts';
import { TerminalVerbs } from './lib/agent-tools/controller.ts';
import { UsageError, Words } from './lib/args.ts';
import { AttachController } from './lib/attach/controller.ts';
import { TerminalSlotsController } from './lib/terminal-slots/controller.ts';

/**
 * The Terminals `fy` half (§2.3): the `terminal …` verbs and `attach` (today's `registerTerminalCommands`, the
 * terminal-slot commands and `fy attach`). Composition only: every verb is a controller over the plugin's client.
 */
export default implementCli(manifest, {
  build: ({ client, io }) => {
    const verbs = new TerminalVerbs(new TerminalToolsClient(client), io);
    const slots = new TerminalSlotsController(client, io);
    const attach = new AttachController(
      client,
      new ExactTmuxAttacher(new BunTmuxAttachProcess(), ambientTmuxEnvironment(), message => io.err(`${message}\n`)),
      io,
    );
    return {
      verbs: {
        'terminal list': async invocation => await verbs.list(invocation),
        'terminal open': async invocation => await verbs.open(invocation),
        'terminal send': async invocation => await verbs.send(invocation),
        'terminal read': async invocation => await verbs.read(invocation),
        'terminal wait': async invocation => await verbs.wait(invocation),
        'terminal close': async invocation => {
          const words = new Words(invocation);
          const allFinished = words.on('all-finished');
          if (!allFinished) return await verbs.close(invocation);
          if (words.args.length > 0) {
            io.err(`${new UsageError('close one terminal by name, or pass --all-finished (not both)').message}\n`);
            return 2;
          }
          return await slots.closeFinished({ json: words.on('json') });
        },
        'terminal slots': async invocation => await slots.slots({ json: new Words(invocation).on('json') }),
        'terminal ask': async invocation => await verbs.ask(invocation),
        'terminal takeover': async invocation => await verbs.takeover(invocation),
        'terminal handback': async invocation => await verbs.handback(invocation),
        'terminal handover': async invocation => await verbs.handover(invocation),
        'terminal control': async invocation => await verbs.control(invocation),
        attach: async invocation => await attach.attach(invocation),
      },
    };
  },
});
