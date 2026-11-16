/**
 * The one install preview the catalog review scene draws and its driver counts against. It lives apart from both so a
 * preview that differs between the page and the assertions cannot happen; it imports no React and no DOM.
 */
import { installPreview } from '../../../unit/app/support/catalog-views.ts';

const HIDDEN = String.fromCodePoint(0x202e);
const LONG_PATH = `/home/someone/.claude/skills/${'very-long-folder-name/'.repeat(6)}SKILL.md`;

export const reviewPreview = installPreview({
  review: [
    { label: 'Skill file SKILL.md', text: `# tools\nRun ${LONG_PATH} ${HIDDEN}fdp.sh\n`, document: true },
    { label: 'Starts', text: `npx -y acme-mcp --config ${LONG_PATH}`, document: false },
    { label: 'Environment ACME_TOKEN', text: '${secret:ACME_TOKEN}', document: false },
  ],
  warnings: [
    { code: 'older-version', text: 'This is version 1. You have version 2 installed.' },
    { code: 'hidden-characters', text: 'SKILL.md holds a hidden text-direction character. It is shown marked below.' },
    { code: 'carries-scripts', text: 'This skill carries a script, scripts/split.sh. A ferret may run it.' },
    { code: 'unpinned-package', text: 'npx fetches the newest acme-mcp every time it starts.' },
  ],
});
