{ lib
, stdenv
, stdenvNoCC
, bun
, git
, makeWrapper
, ...
}:

let
  version = (lib.importJSON ../package.json).version or "0.1.0";

  # bun install as a fixed-output derivation. `bun build --compile` needs the
  # dependency tree present on disk, and only an FOD may reach the network
  # inside the sandbox. NAR hashing ignores mtimes, so bun's output is stable.
  #
  # When package.json or bun.lock change this hash must be updated: build once,
  # take the "got:" value from the mismatch error.
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "git-backup-node-modules";
    inherit version;

    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.unions [ ../package.json ../bun.lock ];
    };

    nativeBuildInputs = [ bun ];
    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      export HOME="$TMPDIR"
      export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
      bun install --frozen-lockfile --no-progress --ignore-scripts
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      cp -R node_modules "$out"
      runHook postInstall
    '';

    dontFixup = true;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = "sha256-TmAar7vdgU/CUjkF34HyEmjJzxZ79znDMEc7QJJN6vY=";
  };
in

stdenv.mkDerivation {
  pname = "git-backup";
  inherit version;

  # Only the inputs that actually affect the compiled binary. Keeping README.md,
  # flake.nix and modules/ out of the source closure means doc churn does not
  # trigger a rebuild.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../src
      ../package.json
      ../tsconfig.json
    ];
  };

  nativeBuildInputs = [ bun makeWrapper ];

  buildPhase = ''
    runHook preBuild

    export HOME="$TMPDIR"
    export BUN_INSTALL_CACHE_DIR="$TMPDIR/bun-cache"
    cp -R ${nodeModules} node_modules

    # Host target only. Cross-compiling would make bun fetch a foreign runtime,
    # which the sandbox forbids.
    bun build --compile --minify --outfile git-backup src/cli.ts

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 git-backup "$out/bin/git-backup"
    runHook postInstall
  '';

  # The compiled binary shells out to `git`. Under launchd the inherited PATH is
  # bare (/usr/bin:/bin:/usr/sbin:/sbin), where macOS resolves git to an xcrun
  # shim whose version depends on the environment and which can prompt for a
  # Command Line Tools install. Every git feature used here exists in Apple's
  # 2.50.1, so this is about determinism, not capability.
  postFixup = ''
    wrapProgram $out/bin/git-backup \
      --prefix PATH : ${lib.makeBinPath [ git ]}
  '';

  meta = {
    description = "Mirror local git repos to a backup remote and snapshot uncommitted work into generational buckets";
    homepage = "https://github.com/smoothbricks/git-backup";
    license = lib.licenses.mit;
    mainProgram = "git-backup";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
  };
}
