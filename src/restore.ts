import { snapRef } from "./buckets.ts";
import type { RepoInfo } from "./repo.ts";

export type RestoreResult =
  | { kind: "missing"; ref: string }
  | { kind: "diff"; ref: string; output: string }
  | { kind: "restored"; ref: string; paths: string[] };

/**
 * Restore from a snapshot bucket.
 *
 * With no paths and no --all this only reports: printing the diff is the safe
 * default for a recovery tool. `--all` uses `git restore --source -- .`, which
 * rewrites paths the snapshot contains but deliberately does NOT delete files
 * created after it - a recovery command should never destroy newer work.
 */
export async function restore(
  repo: RepoInfo,
  bucket: string,
  opts: { all?: boolean; paths?: string[] } = {},
): Promise<RestoreResult> {
  const ref = snapRef(repo.snapKey, bucket);
  if ((await repo.git.rev(ref)) === null) return { kind: "missing", ref };

  const paths = opts.paths ?? [];

  if (paths.length === 0 && !opts.all) {
    const output = await repo.git.tryOut("diff", "--stat", ref);
    return { kind: "diff", ref, output: output ?? "" };
  }

  const targets = paths.length > 0 ? paths : ["."];
  await repo.git.out("restore", `--source=${ref}`, "--worktree", "--", ...targets);
  return { kind: "restored", ref, paths: targets };
}
