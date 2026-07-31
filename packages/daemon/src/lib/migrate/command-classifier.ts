import { worstVerdict, type InflightVerdict } from './verdict.ts';

const words = (value: string): ReadonlySet<string> => new Set(value.split(' '));

const prefixes = words('sudo doas env time nice ionice nohup setsid command builtin exec stdbuf timeout watch');
const safeHeads = words(
  'rg grep egrep fgrep ag ack fd find locate ls ll cat bat head tail jq yq wc echo printf pwd whoami date printenv stat file du df tree which type sort uniq cut tr column nl tac rev realpath dirname basename readlink sleep true false test hostname uname id ps top htop free uptime sed awk less more diff cmp md5sum sha256sum seq zsh bash sh fish dash tmux',
);
const rearmableHeads = words(
  'tsc eslint prettier jest vitest mocha ava tap tape pytest phpunit rspec ctest make cmake ninja gradle mvn bazel buck webpack vite rollup esbuild swc tsx biome ruff mypy flake8 black gofmt rustc gcc g++ cc clang clang++ deno tsserver stylelint tflint',
);
const destructiveHeads = words(
  'rm rmdir mv cp dd shred truncate mkfs mkfifo ln chmod chown chgrp install tee hms darwin-rebuild nixos-rebuild home-manager nix nix-env nix-build nix-shell nix-collect-garbage nixos-rebuild-ng tofu terraform terragrunt pulumi ansible ansible-playbook kubectl helm kustomize argocd loctl kubeadm k9s eksctl sops age gpg rsync scp sftp ssh systemctl service mount umount swapon kill pkill killall pkexec reboot shutdown halt poweroff crontab aws gcloud az doctl vagrant packer flyctl fly apt apt-get dpkg yum dnf rpm pacman apk brew port snap flatpak systemd-run usermod useradd passwd',
);
const packageManagers = words('npm pnpm yarn bun pip pip3 cargo go gem composer poetry uv bundle');
const destructivePackageCommands = words(
  'install add remove uninstall rm ci update upgrade up publish link unlink dedupe prune get sync lock',
);
const rearmablePackageCommands = words('test build lint check fmt format clippy vet tsc compile bench doc');
const runCommands = words('run run-script');
const rearmableScripts = words(
  'build test tests lint check checks typecheck tsc compile fmt format coverage unit e2e bench ci verify validate prettier eslint',
);
const destructiveScripts = words(
  'deploy publish release prod push migrate db db:migrate reset clean prepublish postinstall preinstall install',
);
const readonlyGitCommands = words(
  'status diff log show branch remote rev-parse ls-files describe blame shortlog config fetch cat-file reflog rev-list name-rev whatchanged grep ls-tree',
);
const httpHeads = words('curl wget http https xh httpie');
const mutatingHttp =
  /(^|\s)(-X\s*(post|put|patch|delete)|--request\s+(post|put|patch|delete)|--data\b|--data-\w+|-d\b|--upload-file|-T\b|-F\b|--form\b|--method\s+(post|put|patch|delete))/i;

function basename(word: string): string {
  const parts = word.split('/');
  return parts.at(-1) ?? '';
}

function splitSegments(command: string): readonly string[] {
  return command
    .split(/\|\||&&|[|;&\n]/)
    .map(segment => segment.trim())
    .filter(Boolean);
}

function tokens(segment: string): readonly string[] {
  return segment.split(/\s+/).filter(Boolean);
}

function commandHead(segment: string): string | undefined {
  for (const token of tokens(segment)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    const word = basename(token.replace(/^['"]|['"]$/g, ''));
    if (!word || prefixes.has(word) || /^\d+[smhd]?$/.test(word) || word.startsWith('-')) continue;
    return word;
  }
  return undefined;
}

function classifyGit(segment: string): InflightVerdict {
  const values = tokens(segment);
  const index = values.findIndex(value => basename(value) === 'git');
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
    if (value.startsWith('-')) {
      if (value === '-C' || value === '-c') position++;
      continue;
    }
    return readonlyGitCommands.has(value) ? 'safe_to_kill' : 'destructive_to_interrupt';
  }
  return 'safe_to_kill';
}

function classifyPackageManager(head: string, segment: string): InflightVerdict {
  const values = tokens(segment);
  const index = values.findIndex(value => basename(value) === head);
  for (let position = index + 1; position < values.length; position++) {
    const value = values[position]!;
    if (value.startsWith('-')) continue;
    if (destructivePackageCommands.has(value)) return 'destructive_to_interrupt';
    if (rearmablePackageCommands.has(value)) return 're_armable';
    if (!runCommands.has(value)) return 'unknown';
    for (let scriptPosition = position + 1; scriptPosition < values.length; scriptPosition++) {
      const script = values[scriptPosition]!;
      if (script.startsWith('-')) continue;
      if (destructiveScripts.has(script)) return 'destructive_to_interrupt';
      return rearmableScripts.has(script) ? 're_armable' : 'unknown';
    }
    return 'unknown';
  }
  return 'unknown';
}

function classifySegment(segment: string): InflightVerdict {
  // Shell expansions and output redirects can hide writes. They cannot be safely classified from argv text.
  if (/[`]|\$\(|[<>]/.test(segment)) return 'unknown';
  const head = commandHead(segment);
  if (!head) return 'unknown';
  if (head === 'git') return classifyGit(segment);
  if (packageManagers.has(head)) return classifyPackageManager(head, segment);
  if (httpHeads.has(head)) return mutatingHttp.test(segment) ? 'destructive_to_interrupt' : 'safe_to_kill';
  if (destructiveHeads.has(head)) return 'destructive_to_interrupt';
  if (rearmableHeads.has(head)) return 're_armable';
  return safeHeads.has(head) ? 'safe_to_kill' : 'unknown';
}

/** Safely classify a shell command; ambiguous syntax deliberately refuses migration. */
export function classifyCommand(command: string): InflightVerdict {
  const segments = splitSegments(command.trim());
  return segments.length === 0 ? 'unknown' : worstVerdict(segments.map(classifySegment));
}

/** Classifies non-shell harness tools without assuming unknown tools are harmless. */
export function classifyToolName(name: string): InflightVerdict {
  if (words('Read Grep Glob LS NotebookRead WebFetch WebSearch TodoWrite BashOutput KillBash KillShell').has(name))
    return 'safe_to_kill';
  if (words('Write Edit MultiEdit NotebookEdit').has(name)) return 're_armable';
  return 'unknown';
}
