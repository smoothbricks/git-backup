import { $ } from "bun";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { globalConfigAll } from "./git.ts";
import { loadConfig } from "./config.ts";
import { createDest } from "./remote.ts";
import { destFor, findRepo, type RepoInfo } from "./repo.ts";
import { installHooks } from "./hooks.ts";

/**
 * Fallback registry.
 *
 * The primary registry is git maintenance's own `maintenance.repo`, which is a
 * multi-valued key in the GLOBAL git config. That breaks completely when the
 * global config is read-only - exactly what home-manager's `programs.git`
 * produces, since it materialises ~/.config/git/config as a nix store file.
 * `git maintenance register` then fails, the registry stays permanently empty
 * and every sweep reports "swept 0 repos" while looking perfectly healthy.
 *
 * So registration degrades to a plain file we own. Reads always union both, and
 * a machine with a writable global config still uses maintenance.repo, keeping
 * one registration meaningful to both tools.
 */
export const REGISTRY_FILE = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "git-backup",
  "repos",
);

async function fileRegistry(): Promise<string[]> {
  const f = Bun.file(REGISTRY_FILE);
  if (!(await f.exists())) return [];
  return (await f.text())
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter((l) => l.length > 0);
}

async function writeFileRegistry(paths: readonly string[]): Promise<void> {
  await mkdir(dirname(REGISTRY_FILE), { recursive: true });
  const header = "# Repos swept by git-backup. Managed by 'git backup register'.\n";
  await Bun.write(REGISTRY_FILE, header + [...paths].sort().join("\n") + "\n");
}

/** Every registered repo: git maintenance's list unioned with our own. */
export async function registeredRepos(): Promise<string[]> {
  const merged = new Set([...(await globalConfigAll("maintenance.repo")), ...(await fileRegistry())]);
  return [...merged].sort();
}

/** True when `git config --global` can actually be written. */
export async function globalConfigWritable(): Promise<boolean> {
  const probe = await $`git config --global --add gitbackup.probe 1`.quiet().nothrow();
  if (probe.exitCode !== 0) return false;
  await $`git config --global --unset-all gitbackup.probe`.quiet().nothrow();
  return true;
}

export type RegisterResult = { ok: boolean; where: "maintenance" | "file" | "none"; detail: string };

export async function registerPath(path: string): Promise<RegisterResult> {
  const abs = resolve(path);
  const viaGit = await $`git -C ${abs} maintenance register`.quiet().nothrow();
  if (viaGit.exitCode === 0) return { ok: true, where: "maintenance", detail: "" };

  const current = await fileRegistry();
  if (!current.includes(abs)) await writeFileRegistry([...current, abs]);
  return {
    ok: true,
    where: "file",
    detail: viaGit.stderr.toString().trim().split("\n")[0] ?? "global git config not writable",
  };
}

export async function unregisterPath(path: string): Promise<RegisterResult> {
  const abs = resolve(path);
  let removed = false;

  if ((await $`git -C ${abs} maintenance unregister --force`.quiet().nothrow()).exitCode === 0) {
    removed = true;
  }

  const current = await fileRegistry();
  if (current.includes(abs)) {
    await writeFileRegistry(current.filter((p) => p !== abs));
    removed = true;
  }

  return { ok: removed, where: removed ? "file" : "none", detail: "" };
}

export type InitResult = {
  repo: RepoInfo;
  destUrl: string;
  created: boolean;
  remoteAdded: boolean;
  registered: RegisterResult;
  hooks: string[];
  excluded: boolean;
};

export async function initRepo(
  repo: RepoInfo,
  opts: { root?: string; remote?: string; base?: string; hooks?: boolean; register?: boolean },
): Promise<InitResult> {
  const cfg = await loadConfig(repo.git);
  const root = opts.root ?? cfg.root;
  const remote = opts.remote ?? cfg.remote;
  const base = opts.base ?? cfg.base;

  if (!root) {
    throw new Error(
      "no destination configured.\n" +
        "  Set one globally:  git config --global backup.root /Volumes/Backup/Dev\n" +
        "  Or pass it here:   git backup init --root ssh://host/srv/backup",
    );
  }

  if (opts.root) await repo.git.run("config", "backup.root", opts.root);
  if (opts.base) await repo.git.run("config", "backup.base", opts.base);
  if (opts.remote) await repo.git.run("config", "backup.remote", opts.remote);

  const dest = destFor(root, base, repo.root);

  const probe = await repo.git.run("ls-remote", "--quiet", dest.url);
  let created = false;
  if (!probe.ok) {
    await createDest(dest);
    created = true;
  }

  const existing = await repo.git.tryOut("remote", "get-url", remote);
  let remoteAdded = false;
  if (existing === null) {
    await repo.git.out("remote", "add", remote, dest.url);
    remoteAdded = true;
  } else if (existing !== dest.url) {
    await repo.git.out("remote", "set-url", remote, dest.url);
    remoteAdded = true;
  }

  const registered: RegisterResult =
    opts.register === false
      ? { ok: false, where: "none", detail: "skipped" }
      : await registerPath(repo.root);

  const installed = opts.hooks === false ? { hooks: [], excluded: false } : await installHooks(repo);

  return {
    repo,
    destUrl: dest.url,
    created,
    remoteAdded,
    registered,
    hooks: installed.hooks,
    excluded: installed.excluded,
  };
}

export type RepoSummary = {
  path: string;
  present: boolean;
  hasRemote: boolean;
  enabled: boolean;
  destUrl: string | null;
  snapAge: number | null;
  skipReason: string | null;
};

/** Cheap per-repo summary for `list`. Deliberately does no network work. */
export async function summarize(path: string): Promise<RepoSummary> {
  const base: RepoSummary = {
    path,
    present: false,
    hasRemote: false,
    enabled: true,
    destUrl: null,
    snapAge: null,
    skipReason: null,
  };

  const repo = await findRepo(resolve(path));
  if (!repo) return { ...base, skipReason: "missing" };

  const cfg = await loadConfig(repo.git);
  const destUrl = await repo.git.tryOut("remote", "get-url", cfg.remote);
  const latest = await repo.git.tryOut(
    "for-each-ref",
    "--format=%(committerdate:unix)",
    `refs/backup/snap/${repo.snapKey}/latest`,
  );

  return {
    path,
    present: true,
    hasRemote: destUrl !== null,
    enabled: cfg.enabled,
    destUrl,
    snapAge: latest ? Math.floor(Date.now() / 1000) - Number(latest) : null,
    skipReason: !cfg.enabled ? "disabled" : destUrl === null ? "no backup remote" : null,
  };
}
