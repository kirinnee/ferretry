# Placeholder cask proving the in-repo tap path (Casks/) before the first release.
# GoReleaser overwrites this file on every published release; do not edit by hand.
# Install flow:
#   brew tap kirinnee/pitwall https://github.com/kirinnee/pitwall
#   brew install --cask pitwall
cask "pitwall" do
  version "0.0.0"
  sha256 :no_check # placeholder only — real releases pin per-arch sha256 values

  url "https://github.com/kirinnee/pitwall/releases/download/v#{version}/pitwall_darwin_arm64.tar.gz"
  name "pitwall"
  desc "Command-line client for the per-host agent daemon"
  homepage "https://github.com/kirinnee/pitwall"

  binary "pitwall"

  postflight do
    if OS.mac?
      system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{staged_path}/pitwall"]
    end
  end
end
