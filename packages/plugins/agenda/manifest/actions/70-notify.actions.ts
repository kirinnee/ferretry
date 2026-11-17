/** `fy notify`: tell the owner one thing. Agenda raises the notice through the Asks port (it consumes Asks through `needs`). */
import { manifestFragment, verb } from '@ferretry/kernel/manifest';

export default manifestFragment({
  cli: [
    verb('notify', {
      summary: 'tell the owner one thing: a quiet notice; --buzz also buzzes the phone',
      args: [{ name: 'summary', help: 'one line saying what the owner should know', optional: true, variadic: true }],
      options: [
        { flag: '--ferret <id>', help: 'the same as --session', hidden: true },
        { flag: '--ping [summary]', help: 'the v4 spelling of --buzz', hidden: true },
        { flag: '--body <markdown>', help: 'the longer reading behind the summary, as Markdown' },
        { flag: '--buzz', help: "also buzz the owner's phone" },
        {
          flag: '-s, --session <id>',
          help: 'target another session; an agent may notify only for its own (defaults to the current session)',
        },
      ],
    }),
  ],
});
