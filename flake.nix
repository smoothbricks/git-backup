{
  description = "Mirror local git repos to a backup remote and snapshot uncommitted work into generational buckets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    systems.url = "github:nix-systems/default";
  };

  outputs = { self, nixpkgs, systems }:
    let
      # Pin bun to the latest upstream release rather than whatever nixpkgs
      # happens to carry, following the smoothbricks/tooling convention.
      # Bump with: nix shell nixpkgs#nvfetcher -c nvfetcher -o _sources
      # (run from ./nixpkgs-overlay).
      bunOverlay = final: prev:
        let
          sources = final.callPackage ./nixpkgs-overlay/_sources/generated.nix { };
          bunSource = sources."bun-${final.stdenvNoCC.hostPlatform.system}";
        in
        {
          bun = prev.bun.overrideAttrs (_: {
            inherit (bunSource) version src;
          });
        };

      # legacyPackages cannot take overlays, so instantiate nixpkgs directly.
      pkgs = system: import nixpkgs {
        inherit system;
        overlays = [ bunOverlay ];
      };

      eachSystem = callback: nixpkgs.lib.genAttrs (import systems) (system: callback (pkgs system));
    in
    {
      packages = eachSystem (pkgs: rec {
        default = git-backup;
        git-backup = pkgs.callPackage ./packages/git-backup.nix { };
      });

      devShells = eachSystem (pkgs: {
        default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            bun
            git
            typescript
            nvfetcher
          ];
        };
      });

      apps = eachSystem (pkgs: rec {
        default = git-backup;
        git-backup = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.system}.git-backup;
        };
      });

      formatter = eachSystem (pkgs: pkgs.nixpkgs-fmt);

      overlays = {
        bun = bunOverlay;
        default = final: _prev: {
          git-backup = final.callPackage ./packages/git-backup.nix { };
        };
      };

      # `self` is passed through so the module can default `services.git-backup.package`
      # to this flake's own build for the evaluating system.
      homeManagerModules = rec {
        default = git-backup;
        git-backup = import ./modules/home-manager.nix self;
      };
    };
}
