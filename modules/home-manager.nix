# home-manager module for git-backup (darwin only — the sweep runs under launchd).
#
# Minimal consumer:
#
#   # flake.nix
#   {
#     inputs = {
#       nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
#       home-manager.url = "github:nix-community/home-manager";
#       home-manager.inputs.nixpkgs.follows = "nixpkgs";
#       git-backup.url = "github:smoothbricks/git-backup";
#       git-backup.inputs.nixpkgs.follows = "nixpkgs";
#     };
#
#     outputs = { nixpkgs, home-manager, git-backup, ... }: {
#       homeConfigurations."danny" = home-manager.lib.homeManagerConfiguration {
#         pkgs = nixpkgs.legacyPackages.aarch64-darwin;
#         modules = [ git-backup.homeManagerModules.default ./home.nix ];
#       };
#     };
#   }
#
#   # home.nix
#   { ... }: {
#     services.git-backup = {
#       enable = true;
#       root = "/Volumes/Backup/Dev";   # or "ssh://host/srv/backup"
#       base = "/Users/danny/Dev";
#       interval = 300;
#     };
#   }

self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.git-backup;

  # home-manager derives the launchd label from the agent attribute name, so
  # `launchd.agents.git-backup` becomes `org.nix-community.home.git-backup` —
  # NOT the tool's imperative default of `dev.gitbackup.sweep`. The git hooks
  # installed by `git backup init` kick whatever label `backup.agentLabel`
  # names, so this module must write the home-manager label into git config or
  # every hook-triggered kick would target a nonexistent agent.
  agentLabel = "org.nix-community.home.git-backup";

  # Every value is a string: home-manager's git config generator and
  # `git config --global` both emit strings verbatim.
  backupSettings = {
    root = cfg.root;
    base = cfg.base;
    remote = cfg.remote;
    buckets = lib.concatStringsSep " " cfg.buckets;
    wipInclude = lib.concatStringsSep " " cfg.wipInclude;
    wipIncludeName = lib.concatStringsSep " " cfg.wipIncludeName;
    wipMaxSize = cfg.wipMaxSize;
    attic = lib.boolToString cfg.attic;
    atticExpire = cfg.atticExpire;
    interval = toString cfg.interval;
    inherit agentLabel;
  } // cfg.extraConfig;
in
{
  options.services.git-backup = {
    enable = lib.mkEnableOption "git-backup automatic repository mirroring";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "git-backup.packages.\${system}.default";
      description = "The git-backup package to use.";
    };

    root = lib.mkOption {
      type = lib.types.str;
      default = "";
      example = "/Volumes/Backup/Dev";
      description = ''
        Destination root for mirrors (`backup.root`). Required when enabled.
        Accepts a local path, `ssh://host/srv/backup`, or `host:/srv/backup`.
      '';
    };

    base = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/Dev";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/Dev"'';
      description = ''
        Local prefix stripped from a repo's path to compute its relative
        destination under `root` (`backup.base`).
      '';
    };

    remote = lib.mkOption {
      type = lib.types.str;
      default = "backup";
      description = "Name of the git remote pointing at the backup destination.";
    };

    interval = lib.mkOption {
      type = lib.types.int;
      default = 300;
      description = "Seconds between sweeps (launchd `StartInterval`).";
    };

    buckets = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "latest" "hourly" "daily" "weekly" ];
      description = ''
        Generational snapshot ladder, oldest promoted last. The stock ladder
        holds snapshots aged 0, 1h, 24h and 7d in exactly four refs.
      '';
    };

    wipInclude = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "*.ts"
        "*.tsx"
        "*.js"
        "*.jsx"
        "*.mjs"
        "*.cjs"
        "*.md"
        "*.mdx"
        "*.json"
        "*.jsonc"
        "*.toml"
        "*.yaml"
        "*.yml"
        "*.nix"
        "*.rs"
        "*.go"
        "*.py"
        "*.rb"
        "*.sh"
        "*.bash"
        "*.fish"
        "*.zsh"
        "*.sql"
        "*.css"
        "*.scss"
        "*.html"
        "*.svg"
        "*.txt"
        "*.env.example"
        "*.lock"
      ];
      description = ''
        Globs of *untracked* files eligible for snapshotting. Untracked files
        are allowlisted rather than gitignore-filtered so a stray build
        artifact cannot reach the backup before `.gitignore` catches up.
      '';
    };

    wipIncludeName = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "Makefile"
        "Dockerfile"
        "Containerfile"
        "justfile"
        "Justfile"
        "Taskfile"
        "Rakefile"
        "Gemfile"
        "Procfile"
        "LICENSE"
        "README"
        ".envrc"
        ".gitignore"
        ".gitattributes"
        "flake.lock"
      ];
      description = "Exact basenames of untracked files to include, for extensionless files.";
    };

    wipMaxSize = lib.mkOption {
      type = lib.types.str;
      default = "1m";
      description = "Per-file size cap for untracked files, in `git config` size units.";
    };

    attic = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Preserve overwritten remote tips under `refs/backup/attic/`.";
    };

    atticExpire = lib.mkOption {
      type = lib.types.str;
      default = "90d";
      description = "Age at which `git backup gc` drops attic refs.";
    };

    startOnMount = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Run a sweep whenever a volume is mounted. Worth keeping for a removable
        or network `root`; pointless when the destination is reached over ssh.
      '';
    };

    logFile = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/Library/Logs/git-backup.log";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/Library/Logs/git-backup.log"'';
      description = "Path the launchd agent writes stdout and stderr to.";
    };

    extraConfig = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { wipIncludeFile = ".backupinclude"; };
      description = "Additional `backup.*` git config keys merged into the generated global config.";
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [ cfg.package ];

      assertions = [
        {
          assertion = pkgs.stdenv.hostPlatform.isDarwin;
          message = ''
            services.git-backup is darwin-only: it schedules sweeps through
            launchd. On Linux, install the package and drive
            `git backup sweep` from a systemd user timer instead.
          '';
        }
        {
          assertion = cfg.root != "";
          message = ''
            services.git-backup.root must be set to the backup destination
            root, e.g. "/Volumes/Backup/Dev" or "ssh://host/srv/backup".
          '';
        }
      ];

      launchd.agents.git-backup = {
        enable = true;
        config = {
          ProgramArguments = [ "${lib.getExe cfg.package}" "sweep" ];
          StartInterval = cfg.interval;
          StartOnMount = cfg.startOnMount;
          ThrottleInterval = 60;
          ProcessType = "Background";
          LowPriorityIO = true;
          RunAtLoad = false;
          StandardOutPath = cfg.logFile;
          StandardErrorPath = cfg.logFile;
        };
      };
    }

    # The user may or may not manage git through home-manager, so write the
    # global `backup.*` config through whichever route is actually available.
    (lib.mkIf config.programs.git.enable {
      programs.git.extraConfig.backup = backupSettings;
    })

    (lib.mkIf (!config.programs.git.enable) {
      home.activation.gitBackupConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] (
        lib.concatStringsSep "\n" (lib.mapAttrsToList
          (key: value: ''
            run ${pkgs.git}/bin/git config --global ${lib.escapeShellArg "backup.${key}"} ${lib.escapeShellArg value}
          '')
          backupSettings)
      );
    })
  ]);
}
