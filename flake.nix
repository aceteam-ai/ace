{
  description = "Ace CLI - TypeScript CLI for running AI workflows locally";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        libPathVar = if pkgs.stdenv.isDarwin then "DYLD_LIBRARY_PATH" else "LD_LIBRARY_PATH";
        runtimeLibs = with pkgs; [ stdenv.cc.cc ];
        libPath = pkgs.lib.makeLibraryPath runtimeLibs;

        wrappedUv = pkgs.writeShellScriptBin "uv" ''
          export ${libPathVar}="${libPath}:''$${libPathVar}"
          exec ${pkgs.uv}/bin/uv "$@"
        '';

      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm
            pkgs.python312
            wrappedUv
            pkgs.git
            pkgs.gh
          ];

          shellHook = ''
            echo ""
            echo "ace dev environment"
            echo ""
            echo "  Node $(node --version) | pnpm $(pnpm --version) | Python $(python3 --version | cut -d' ' -f2)"
            echo ""
            echo "  pnpm install            # deps"
            echo "  pnpm build              # build"
            echo "  pnpm lint               # type check"
            echo "  ./release.sh --dry-run  # release preview"
            echo ""
          '';
        };
      });
}
