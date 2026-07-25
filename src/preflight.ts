import { $ } from "bun";

/**
 * Highest git feature we rely on is `rev-parse --path-format=absolute` (2.31).
 * Everything else - maintenance register (2.29), restore --source (2.23),
 * branch --show-current (2.22), for-each-ref lstrip (2.13) - is older.
 *
 * Verified against Apple's /usr/bin/git 2.50.1 in a clean environment: all
 * features present. The nix wrapper pins git for determinism, not capability,
 * because /usr/bin/git is an xcrun shim whose resolution depends on the
 * environment and which can prompt for a Command Line Tools install.
 */
export const MIN_GIT = "2.31.0";

export type Preflight = { path: string; version: string };

export async function preflight(): Promise<Preflight> {
  const path = Bun.which("git");
  if (!path) {
    throw new Error(
      "git not found on PATH.\n" +
        "  Under launchd the PATH is minimal; install the nix package (which wraps\n" +
        "  git-backup with git on PATH) or set PATH in the agent's plist.",
    );
  }

  const res = await $`${path} --version`.quiet().nothrow();
  if (res.exitCode !== 0) throw new Error(`could not run ${path} --version`);

  const raw = res.stdout.toString().trim();
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) throw new Error(`could not parse git version from: ${raw}`);
  const version = `${m[1]}.${m[2]}.${m[3]}`;

  if (!Bun.semver.satisfies(version, `>=${MIN_GIT}`)) {
    throw new Error(
      `git ${version} is too old (need >=${MIN_GIT}).\n` +
        `  Found: ${path}\n` +
        "  git-backup needs 'rev-parse --path-format=absolute', added in 2.31.",
    );
  }

  return { path, version };
}
