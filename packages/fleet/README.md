# fleet

Fleet management (agent wrappers, homes, models) as a library plus CLI subcommands.

Account route homes should use a clear relative name, such as `claude-work` or `codex-loge`.
Relative names resolve to `<FY_HOME>/fleet/homes/<name>` (normally
`~/.ferretry/fleet/homes/<name>`), keeping each account home beneath Ferretry.
Fleet apply materializes profile assets as copies, including directories, so no asset symlink is
introduced into that state home; edits to a source asset take effect on the next apply.
The workspace boundary is live; later migration units add the provisioning capabilities.
