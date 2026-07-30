# Placeholder cask proving the in-repo tap path (Casks/) before the first release.
# GoReleaser overwrites this file on every published release; do not edit by hand.
# Install flow:
#   brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry
#   brew install --cask ferretry
cask "ferretry" do
  version "0.0.0"
  sha256 :no_check # placeholder only — real releases pin per-arch sha256 values

  url "https://github.com/kirinnee/ferretry/releases/download/v#{version}/fy_darwin_arm64.tar.gz"
  name "ferretry"
  desc "Command-line client for the per-host agent daemon"
  homepage "https://github.com/kirinnee/ferretry"

  binary "fy"

  postflight do
    if OS.mac?
      system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}/fy"]
    end
  end
end
