import type { Git } from "./git.ts";

/**
 * The generational ladder. Each bucket is refreshed once it is older than its
 * interval, which yields the invariant: at any instant you hold a snapshot from
 * <=5min, <=1h, <=1d and <=1w ago, in exactly four refs.
 */
export const LADDER: Record<string, number> = {
  latest: 0,
  hourly: 3600,
  daily: 86400,
  weekly: 604800,
};

/**
 * `snapKey` is "<host>/<worktree>" - two path components, always. Ref names may
 * not contain `~`, `^`, `:` or space (git reserves them for revision syntax), so
 * the worktree is a separate component rather than a suffix on the host.
 */
export function snapRef(snapKey: string, bucket: string): string {
  return `refs/backup/snap/${snapKey}/${bucket}`;
}

export type BucketState = { bucket: string; sha: string; committed: number };

/** Read every bucket's tip and commit time for this worktree in one fork. */
export async function readBuckets(git: Git, snapKey: string): Promise<BucketState[]> {
  const out = await git.lines(
    "for-each-ref",
    "--format=%(refname:lstrip=5) %(objectname) %(committerdate:unix)",
    `refs/backup/snap/${snapKey}/`,
  );
  const states: BucketState[] = [];
  for (const line of out) {
    const [bucket, sha, ts] = line.split(" ");
    if (bucket && sha && ts) states.push({ bucket, sha, committed: Number(ts) });
  }
  return states;
}

/**
 * Point every due bucket at `commit`. `latest` always moves; the rest move only
 * once the ref they already hold has aged past its interval.
 */
export async function rotate(
  git: Git,
  snapKey: string,
  buckets: string[],
  commit: string,
  now = Math.floor(Date.now() / 1000),
): Promise<string[]> {
  const state = new Map((await readBuckets(git, snapKey)).map((s) => [s.bucket, s]));
  const moved: string[] = [];

  for (const bucket of buckets) {
    const interval = LADDER[bucket];
    if (interval === undefined) continue;

    const current = state.get(bucket);
    if (current !== undefined && interval > 0 && now - current.committed < interval) continue;

    const ref = snapRef(snapKey, bucket);
    const res = await git.run("update-ref", ref, commit);
    // Never report a bucket as rotated when the ref write failed - an invalid
    // ref name used to fail here silently and lose the snapshot entirely.
    if (!res.ok) throw new Error(`could not update ${ref}: ${res.stderr.trim()}`);
    moved.push(bucket);
  }

  return moved;
}
