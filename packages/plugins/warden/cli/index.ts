import { implementCli, type VerbInvocation } from '@ferretry/kernel/manifest';
import { DialogLearnAnswerSchema, type DialogLearnAnswer } from '../contract/dialog-rules.ts';
import manifest from '../manifest.ts';

/** What `fy warden dialog learn` prints: the screen, what each row is, the rule proposed and what to do next. */
export function renderLearn(answer: DialogLearnAnswer, ferret: string): string {
  const { proposal } = answer;
  const rows = proposal.rows.map(row => `  ${row.pressed ? '→' : ' '} ${String(row.number)}. ${row.label}`);
  const lines = [`${ferret} is parked on: ${proposal.title}`, ...rows];
  if (answer.saved) lines.push('', 'Saved. The next time that screen shows, it is cleared at once.');
  else if (answer.heldFor.length > 0)
    lines.push('', 'Held for you (nothing is in effect yet):', ...answer.heldFor.map(sentence => `  - ${sentence}`));
  else if (proposal.rule !== undefined)
    lines.push(
      '',
      `Proposed rule ${proposal.rule.id}: when this screen shows, ${'press' in proposal.rule.action ? 'press Esc' : `choose “${proposal.rule.action.choose}”`}.`,
      `To save it: fy warden dialog learn ${ferret} --confirm`,
    );
  if (proposal.note !== undefined) lines.push('', proposal.note);
  return `${lines.join('\n')}\n`;
}

/**
 * `fy warden dialog learn <ferret> [--confirm] [--row N]`: the owner teaches Ferretry how to leave a screen it does not
 * know. Without `--confirm` it only PROPOSES (nothing is saved); `--confirm` is the owner's yes. A refusal prints its
 * sentence and exits 1.
 */
export default implementCli(manifest, {
  build({ client, io }) {
    return {
      verbs: {
        'warden dialog learn': async (invocation: VerbInvocation): Promise<number> => {
          const ferret = invocation.args[0] ?? '';
          const row = invocation.options['row'];
          try {
            const answer = DialogLearnAnswerSchema.parse(
              await client.call('POST /v1/warden/dialog/learn', {
                body: {
                  ferret,
                  ...(invocation.options['confirm'] === true ? { confirm: true } : {}),
                  ...(typeof row === 'string' && row !== '' ? { row: Number(row) } : {}),
                },
              }),
            );
            io.out(
              invocation.options['json'] === true
                ? `${JSON.stringify(answer, null, 2)}\n`
                : renderLearn(answer, ferret),
            );
            return 0;
          } catch (error) {
            io.err(`${error instanceof Error ? error.message : String(error)}\n`);
            return 1;
          }
        },
      },
    };
  },
});
