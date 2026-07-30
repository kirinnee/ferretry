// Minimal module so GoReleaser's Go builder can compile the goreleaser.go placeholder.
// The shipped binary is the prebuilt Bun binary swapped in by the post-build hook.
// The module name is the product name, rewritten by scripts/local/rename.sh.
module ferretry

go 1.22
