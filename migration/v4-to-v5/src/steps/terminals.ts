import { join } from 'node:path';
import { linkSocket } from '../sealed.ts';
import { configs, info, paneFor } from '../v4/ferrets.ts';
import type { Step } from './index.ts';

export const terminalsStep: Step = {
  id: 'terminals',
  title: 'Terminals (running ferrets handed over by pane handle)',
  owner: ['plugin-terminals'],
  reads: ['state/sessions/<sid>/terminal-pane.json', 'tmux.sock'],
  sealed: [],
  notCarried: [
    {
      what: 'terminals.json',
      why: 'Terminals declares the file but exports no persisted document schema; pane handles are carried only in FerretRecord.handle by the ferrets step',
    },
    {
      what: 'terminal-pane daemonId, tmuxSession, pid and processStartTicks',
      why: 'FerretRecordSchema exposes only handle; Terminals has no persisted pane-proof schema',
    },
    { what: 'in-flight input holds', why: 'closed and quarantined at restart' },
  ],
  async run(ctx) {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried, sealed: [] };
    try {
      let panes = 0;
      for (const config of await configs(ctx.v4.sessions)) if (await paneFor(ctx.v4.sessions, config)) panes++;
      const socket = join(ctx.v4.home, 'tmux.sock');
      const source = await info(socket);
      if (source !== undefined && !source.isSocket()) throw new Error('invalid socket');
      if (source !== undefined && !ctx.dryRun) await linkSocket(socket, ctx.v5.resolve('state/terminals/tmux.sock'));
      return {
        ...base,
        status: 'converted' as const,
        kept: [
          { what: 'tmux sockets linked without connecting', count: source === undefined ? 0 : 1 },
          { what: 'pane handles available in ferret records', count: panes },
        ],
      };
    } catch {
      return {
        ...base,
        status: 'failed' as const,
        note: 'cannot convert terminal input: invalid data or socket link failed',
        kept: [],
      };
    }
  },
};
