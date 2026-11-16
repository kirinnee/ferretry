/**
 * `fy transcript`, the conversation transcript every runtime of a harness shares. It sits last because the manifest
 * declared it after the link verbs, and a list's order is part of the contract hash.
 */
import { verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  cli: [
    verb('transcript', {
      summary: 'the conversation transcript every runtime of a harness shares',
      args: [{ name: 'ferret', help: 'the ferret whose conversation to read' }],
      options: [
        { flag: '--cursor <cursor>', help: 'continue from where the last page ended' },
        { flag: '--through <row>', help: 'end at this row' },
        { flag: '--tail', help: 'read the newest rows' },
        { flag: '--limit <n>', help: 'how many rows' },
        { flag: '--json', help: 'print the answer as JSON' },
      ],
    }),
  ],
});
