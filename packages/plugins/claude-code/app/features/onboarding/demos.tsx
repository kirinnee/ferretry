/** The two small demos, pure CSS, each plays once and stays on its last frame (with motion reduced it is that frame). */

/** A terminal line typing `claude --version`, then the answer. */
export function InstalledDemo() {
  return (
    <div
      className="cc-demo"
      role="img"
      aria-label="A terminal: claude --version answers with a version number"
      data-demo="installed"
    >
      <p className="cc-demo__line">
        <span aria-hidden="true">$ </span>
        <span className="cc-type">claude --version</span>
      </p>
      <p className="cc-demo__line cc-fade">2.1.0 (Claude Code)</p>
    </div>
  );
}

/** An agent that asks before running a command, against one that runs it straight through. */
export function PermissionDemo({ mode }: { readonly mode: 'auto' | 'skip' }) {
  return (
    <div
      className="cc-demo"
      role="img"
      aria-label={
        mode === 'auto'
          ? 'Claude asks before it runs a command'
          : 'Claude runs the command straight through, without asking'
      }
      data-demo={`permission-${mode}`}
      key={mode}
    >
      <p className="cc-demo__line">› rm -rf build/</p>
      {mode === 'auto' ? (
        <p className="cc-demo__line cc-ask">Run this command? [y/N]</p>
      ) : (
        <p className="cc-demo__line cc-run">✓ ran, without asking</p>
      )}
    </div>
  );
}
