/** `fy history` and `fy history claim`: the wrapper's conversation claim. */
import { verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  cli: [
    // V-0282 / V-0283: the wrapper's claim before it `exec`s a resumed harness (one live writer per conversation, §9.3).
    verb('history', {
      summary: 'the conversations every runtime of a harness shares',
      args: [],
      options: [],
    }),
    verb('history claim [words...]', {
      summary: 'claim a conversation for one writer before a harness resumes it; refused while another is writing it',
      args: [
        {
          name: 'words',
          help: 'the conversation id, or with --from-arguments the harness arguments to read it from',
          optional: true,
          variadic: true,
        },
      ],
      options: [
        { flag: '--harness <harness>', help: 'the harness the conversation belongs to (claude or codex)' },
        { flag: '--pid <pid>', help: 'the process that will write the conversation (a wrapper passes $$)' },
        { flag: '--from-arguments', help: 'read the conversation id from the harness arguments that follow' },
      ],
    }),
  ],
});
