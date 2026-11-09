/**
 * What the edit screen is given for an instructions file holding `text`: the one door a component's text leaves by
 * (`componentCatalog`), which runs `redactText` over it. Shared by the redaction tests (S21 to S26).
 */
import { componentCatalog } from '../../../daemon/lib/service/catalog.ts';
import { parseAccountModel } from '../../../daemon/lib/account/schema.ts';

const MODEL = parseAccountModel({ version: 1, components: { instructions: { notes: { file: 'notes.md' } } } });

export const HIDDEN = '‹hidden›';

export function shownFor(text: string): { text: string; redacted: boolean } {
  const catalog = componentCatalog(MODEL, {
    format: 'present',
    machineName: 'box',
    tools: { claude: undefined, codex: undefined },
    runningSessions: 0,
    userHome: '/home/person',
    acceptsAutoPermissionMode: true,
    instructionBodies: { notes: text },
  });
  const content = catalog.kinds[0]?.components[0]?.content;
  if (content?.form !== 'text') throw new Error('expected text content');
  return { text: content.text, redacted: content.redacted };
}
