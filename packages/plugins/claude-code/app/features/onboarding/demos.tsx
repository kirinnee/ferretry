/** The two small demos Claude's pages show: the shared ones from the import kit (Codex's pages draw the same), with Claude's words. */
import {
  InstalledDemo as InstalledDemoBox,
  PermissionDemo as PermissionDemoBox,
} from '@ferretry/plugin-runtimes/import-kit';

/** A terminal line typing `claude --version`, then the answer. */
export const InstalledDemo = () => (
  <InstalledDemoBox command="claude --version" answer="2.1.0 (Claude Code)" label="Claude" />
);

/** An agent that asks before running a command, against one that runs it straight through. */
export const PermissionDemo = ({ mode }: { readonly mode: 'auto' | 'skip' }) => (
  <PermissionDemoBox tool="Claude" mode={mode} />
);
