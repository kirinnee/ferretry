/** Word tables the command classifier matches argv heads and subcommands against. */

const words = (value: string): ReadonlySet<string> => new Set(value.split(' '));

/** Wrappers that delegate to the real command, so the head is whatever follows them. */
export const prefixes = words('sudo doas env time nice ionice nohup setsid command builtin exec stdbuf timeout watch');

/**
 * Read-only or ephemeral commands. Interpreters (`bash`, `sed`, `find`, `tmux`) are deliberately
 * absent: what they do is decided by their arguments, so they get argument-aware classifiers.
 */
export const safeHeads = words(
  'rg grep egrep fgrep ag ack fd locate ls ll cat bat head tail jq yq wc echo printf pwd whoami date printenv stat file du df tree which type sort uniq cut tr column nl tac rev realpath dirname basename readlink sleep true false test hostname uname id ps top htop free uptime less more diff cmp md5sum sha256sum seq',
);

export const rearmableHeads = words(
  'tsc eslint prettier jest vitest mocha ava tap tape pytest phpunit rspec ctest make cmake ninja gradle mvn bazel buck webpack vite rollup esbuild swc tsx biome ruff mypy flake8 black gofmt rustc gcc g++ cc clang clang++ deno tsserver stylelint tflint',
);

export const destructiveHeads = words(
  'rm rmdir mv cp dd shred truncate mkfs mkfifo ln chmod chown chgrp install tee hms darwin-rebuild nixos-rebuild home-manager nix nix-env nix-build nix-shell nix-collect-garbage nixos-rebuild-ng tofu terraform terragrunt pulumi ansible ansible-playbook kubectl helm kustomize argocd loctl kubeadm k9s eksctl sops age gpg rsync scp sftp ssh systemctl service mount umount swapon kill pkill killall pkexec reboot shutdown halt poweroff crontab aws gcloud az doctl vagrant packer flyctl fly apt apt-get dpkg yum dnf rpm pacman apk brew port snap flatpak systemd-run usermod useradd passwd',
);

export const packageManagers = words('npm pnpm yarn bun pip pip3 cargo go gem composer poetry uv bundle');
export const destructivePackageCommands = words(
  'install add remove uninstall rm ci update upgrade up publish link unlink dedupe prune get sync lock',
);
export const rearmablePackageCommands = words('test build lint check fmt format clippy vet tsc compile bench doc');
export const runCommands = words('run run-script');
export const rearmableScripts = words(
  'build test tests lint check checks typecheck tsc compile fmt format coverage unit e2e bench ci verify validate prettier eslint',
);
export const destructiveScripts = words(
  'deploy publish release prod push migrate db db:migrate reset clean prepublish postinstall preinstall install',
);

/** `config` is absent on purpose: `git config a b` writes. It gets its own classifier. */
export const readonlyGitCommands = words(
  'status diff log show branch remote rev-parse ls-files describe blame shortlog fetch cat-file reflog rev-list name-rev whatchanged grep ls-tree',
);
export const writingGitConfigFlags = words(
  '--unset --unset-all --add --replace-all --rename-section --remove-section --edit -e',
);
export const readingGitConfigFlags = words('--get --get-all --get-regexp --get-urlmatch --list -l');

/** Interpreters whose argv is a program we cannot read from the process table. */
export const shellHeads = words('bash sh zsh fish dash ksh');
/** Shell flags that take the program to run as their next argument. */
export const shellCommandFlags = words('-c -lc -ic -cl');
/** Stream editors that only mutate a file when an in-place flag is present. */
export const streamEditors = words('sed awk');

/** `find` actions that write, and actions whose payload is a whole nested command. */
export const findWritingActions = words('-delete -fls -fprint -fprint0 -fprintf');
export const findExecActions = words('-exec -execdir -ok -okdir');

/** tmux subcommands that only read server state. Anything else can kill or drive a pane. */
export const readonlyTmuxCommands = words(
  'display-message display display-panes list-sessions list-panes list-windows list-clients list-buffers list-keys list-commands show-options show-window-options show-environment show-messages has-session capture-pane info server-info',
);
/** tmux server options that consume the following argument. */
export const tmuxValueFlags = words('-S -f -L');

export const httpHeads = words('curl wget http https xh httpie');
export const mutatingHttp =
  /(^|\s)(-X\s*(post|put|patch|delete)|--request\s+(post|put|patch|delete)|--data\b|--data-\w+|-d\b|--upload-file|-T\b|-F\b|--form\b|--method\s+(post|put|patch|delete))/i;

/** `-i`, `-ni`, `-i.bak`, `--in-place` — but never `--include` or a bare `-n`. */
export const inPlaceFlag = /^(--in-place\b|-(?!-)[A-Za-z]*i)/;

export const safeToolNames = words(
  'Read Grep Glob LS NotebookRead WebFetch WebSearch TodoWrite BashOutput KillBash KillShell',
);
export const rearmableToolNames = words('Write Edit MultiEdit NotebookEdit');
