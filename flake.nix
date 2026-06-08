{
  description = "Solana Development Environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    anchor-overlay.url = "github:vaporif/anchor-overlay";
    solana-nix.url = "github:xlittlerag/solana-nix";
  };

  outputs = {
    self,
    nixpkgs,
    flake-utils,
    anchor-overlay,
    solana-nix,
  }:
    flake-utils.lib.eachDefaultSystem (
      system: let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [anchor-overlay.overlays.default];
        };
      in {
        devShells.default = pkgs.mkShell {
          name = "solana-dev-env";

          buildInputs = with pkgs; [
            anchor-cli
            solana-rust
            solana-nix.packages.${system}.solana-cli
            pkgs.nodejs
            pkgs.yarn
          ];

          shellHook = ''
            echo "=========================================="
            echo " 🦀 Solana Development Environment Loaded"
            echo "=========================================="

            if command -v solana &> /dev/null; then
              echo "Solana: $(solana --version)"
            fi

            if command -v anchor &> /dev/null; then
              echo "Anchor: $(anchor --version)"
            fi

            if command -v rustc &> /dev/null; then
              echo "Rust: $(rustc --version)"
            fi
          '';
        };
      }
    );
}
