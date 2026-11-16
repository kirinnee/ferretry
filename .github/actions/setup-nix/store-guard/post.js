// Post step for the AtomiCloud setup-nix action (Namespace Linux): runs
// `scripts/store-guard.sh end` (size check before the volume is committed, and a notice when
// the job changed nothing in /nix). The volume only commits when the job exits 0, so this
// step MUST NEVER fail the job: any error becomes a warning and the step returns normally.
// Dependency-free on purpose: the script prints the workflow commands itself.

const { spawnSync } = require('child_process');

function getInput(name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] || '').trim();
}

try {
  const script = getInput('script');
  if (!script) {
    console.log('::notice::setup-nix store guard: no script path; skipping.');
  } else {
    const env = {
      ...process.env,
      IDLE_COMMIT_NOTICE_MINUTES: getInput('idle-commit-notice-minutes'),
    };
    const r = spawnSync('bash', [script, 'end'], { stdio: 'inherit', env, timeout: 120000 });
    if (r.error) console.log(`::warning::setup-nix store guard: ${r.error.message}`);
  }
} catch (e) {
  console.log(`::warning::setup-nix store guard: ${e && e.message ? e.message : e}`);
}
