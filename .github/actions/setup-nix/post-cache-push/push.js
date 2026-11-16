// Post step for the AtomiCloud setup-nix action (macOS Namespace path).
//
// Pushes every valid store path from the job back to the local file:// binary cache
// that lives on the Namespace cache volume. The volume only commits when the job
// exits 0, so this step MUST NEVER fail the job: every error path emits a workflow
// notice/warning and returns normally. Dependency-free on purpose (no node_modules to
// vendor) — we emit `::notice::`/`::warning::` workflow commands directly, which is what
// @actions/core would do anyway.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function notice(msg) {
  console.log(`::notice::${msg}`);
}

function warn(msg) {
  console.log(`::warning::${msg}`);
}

function getInput(name) {
  const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
  return (process.env[key] || '').trim();
}

// Resolve a working `nix`: PATH first, then the default profile (the post context's PATH
// may not include the installer's shims).
function resolveNix() {
  const candidates = ['nix', '/nix/var/nix/profiles/default/bin/nix'];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

function main() {
  const cachePath = getInput('cache-path');
  if (!cachePath) {
    notice('setup-nix cache push: no cache-path provided; skipping.');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(cachePath);
  } catch {
    notice(`setup-nix cache push: cache path '${cachePath}' does not exist; skipping.`);
    return;
  }
  if (!stat.isDirectory()) {
    notice(`setup-nix cache push: cache path '${cachePath}' is not a directory; skipping.`);
    return;
  }
  try {
    fs.accessSync(cachePath, fs.constants.W_OK);
  } catch {
    notice(`setup-nix cache push: cache path '${cachePath}' is not writable; skipping.`);
    return;
  }

  const nix = resolveNix();
  if (!nix) {
    notice('setup-nix cache push: nix not found on PATH or default profile; skipping.');
    return;
  }

  // Bundled alongside this file so it resolves whether __dirname is the real action
  // checkout or the workspace symlink the composite action created.
  const script = path.join(__dirname, 'file-cache-push.sh');
  // Run from the consumer repo at GITHUB_WORKSPACE (harmless for --all, kept for clarity).
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();

  const result = spawnSync('bash', [script, cachePath], {
    stdio: 'inherit',
    cwd,
    env: { ...process.env, NIX_BIN: nix },
  });

  if (result.error) {
    warn(`setup-nix cache push: failed to run push script: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    warn(`setup-nix cache push: push script exited with code ${result.status}; cache may be incomplete.`);
    return;
  }
}

main();
