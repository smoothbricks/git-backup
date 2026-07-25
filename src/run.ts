import { mkdir, rmdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "./config.ts";
import { destFor, findRepo, type RepoInfo } from "./repo.ts";
import { rotate } from "./buckets.ts";
import { snapshot, type SnapResult } from "./snapshot.ts";
import {
  atticSweep, lsRemote, pushAll, reachable,
  type AtticEntry, type PushOutcome,
} from "./remote.ts";
import { registeredRepos } from "./registry.ts";

export type RunStatus = "backed-up" | "nothing" | "unreachable" | "skipped" | "error";

export type RunOutcome = {
  path: string;
  status: RunStatus;
  snap: SnapResult | null;
  push: PushOutcome | null;
  attic: AtticEntry[];
  buckets: string[];
  detail: string;
};

/**
 * Are there commits the destination has not seen?
 *
 * Answered entirely offline by comparing refs/heads against the remote-tracking
 * refs that git updates after each successful push. That ordering matters: the
 * common sweep finds nothing to do and never opens a connection.
 */
async function commitsPending(repo: RepoInfo, remote: string): Promise<boolean> {
  const heads = await repo.git.lines("for-each-ref", "--format=%(refname:lstrip=2) %(objectname)", "refs/heads/");
  const tracked = new Map<string, string>();
  for (const line of await repo.git.lines(
    "for-each-ref",
    "--format=%(refname:lstrip=3) %(objectname)",
    `refs/remotes/${remote}/`,
  )) {
    const [name, sha] = line.split(" ");
    if (name && sha) tracked.set(name, sha);
  }

  for (const line of heads) {
    const [name, sha] = line.split(" ");
    if (!name || !sha) continue;
    if (tracked.get(name) !== sha) return true;
  }
  return false;
}

export async function runRepo(
  repo: RepoInfo,
  opts: { dryRun?: boolean; allFiles?: boolean; snapOnly?: boolean; pushOnly?: boolean } = {},
): Promise<RunOutcome> {
  const out: RunOutcome = {
    path: repo.root, status: "nothing", snap: null, push: null,
    attic: [], buckets: [], detail: "",
  };

  const cfg: Config = await loadConfig(repo.git);
  if (!cfg.enabled) return { ...out, status: "skipped", detail: "backup.enabled=false" };
  if (!cfg.root) return { ...out, status: "skipped", detail: "backup.root not set" };
  if ((await repo.git.tryOut("remote", "get-url", cfg.remote)) === null) {
    return { ...out, status: "skipped", detail: `no '${cfg.remote}' remote` };
  }

  if (!opts.pushOnly) {
    out.snap = await snapshot(repo, cfg, { allFiles: opts.allFiles });
    if (out.snap.kind === "created" && !opts.dryRun) {
      out.buckets = await rotate(repo.git, repo.snapKey, cfg.buckets, out.snap.commit);
    }
  }

  if (opts.snapOnly) {
    out.status = out.snap?.kind === "created" ? "backed-up" : "nothing";
    return out;
  }

  const madeSnapshot = out.snap?.kind === "created";
  if (!madeSnapshot && !(await commitsPending(repo, cfg.remote))) {
    return { ...out, status: "nothing", detail: "up to date" };
  }

  const dest = destFor(cfg.root, cfg.base, repo.root);
  const reach = await reachable(repo, cfg, dest);
  if (!reach.ok) return { ...out, status: "unreachable", detail: reach.reason };

  const remoteRefs = await lsRemote(repo.git, cfg.remote);
  const { saved, unsalvageable } = await atticSweep(repo, cfg, remoteRefs);
  out.attic = saved;
  if (unsalvageable.length > 0) out.detail = `objects gone, not atticked: ${unsalvageable.join(", ")}`;

  out.push = await pushAll(repo, cfg, { dryRun: opts.dryRun });
  out.status = out.push.ok ? "backed-up" : "error";
  if (!out.push.ok) out.detail = out.push.error;
  return out;
}

const LOCK = join(process.env.HOME ?? tmpdir(), "Library", "Caches", "git-backup", "sweep.lock");

/** Atomic mkdir lock with stale-PID recovery, so overlapping sweeps cannot race. */
async function acquireLock(): Promise<boolean> {
  await mkdir(join(LOCK, ".."), { recursive: true }).catch(() => {});
  try {
    await mkdir(LOCK);
  } catch {
    try {
      const pid = Number(await readFile(join(LOCK, "pid"), "utf8"));
      process.kill(pid, 0);
      return false;
    } catch {
      await rmdir(LOCK).catch(() => {});
      try {
        await mkdir(LOCK);
      } catch {
        return false;
      }
    }
  }
  await writeFile(join(LOCK, "pid"), String(process.pid));
  return true;
}

async function releaseLock(): Promise<void> {
  await Bun.file(join(LOCK, "pid")).delete().catch(() => {});
  await rmdir(LOCK).catch(() => {});
}

export type SweepReport = { outcomes: RunOutcome[]; locked: boolean };

export async function sweep(opts: { dryRun?: boolean } = {}): Promise<SweepReport> {
  if (!(await acquireLock())) return { outcomes: [], locked: true };

  try {
    const outcomes: RunOutcome[] = [];
    for (const path of await registeredRepos()) {
      const repo = await findRepo(path);
      if (!repo) {
        outcomes.push({
          path, status: "skipped", snap: null, push: null,
          attic: [], buckets: [], detail: "not a git repo (stale registry entry)",
        });
        continue;
      }
      try {
        outcomes.push(await runRepo(repo, { dryRun: opts.dryRun }));
      } catch (e) {
        outcomes.push({
          path, status: "error", snap: null, push: null, attic: [], buckets: [],
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { outcomes, locked: false };
  } finally {
    await releaseLock();
  }
}
