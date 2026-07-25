import { loadConfig } from "./config.ts";
import { humanAge } from "./config.ts";
import { destFor, type RepoInfo } from "./repo.ts";
import { readBuckets } from "./buckets.ts";
import { listAttic, lsRemote, reachable, unpushedCount } from "./remote.ts";
import { hooksInstalled } from "./hooks.ts";
import { registeredRepos } from "./registry.ts";
import { agentStatus } from "./agent.ts";

export type StatusReport = {
  lines: string[];
  healthy: boolean;
};

export async function status(repo: RepoInfo): Promise<StatusReport> {
  const cfg = await loadConfig(repo.git);
  const lines: string[] = [];
  let healthy = true;

  lines.push(`repo:        ${repo.root}`);
  if (repo.linked) lines.push(`worktree:    ${repo.worktree} (linked)`);
  lines.push(`refs prefix: refs/backup/snap/${repo.snapKey}/`);

  if (!cfg.root) {
    lines.push("destination: NOT CONFIGURED  (git config --global backup.root <url>)");
    healthy = false;
  } else {
    const dest = destFor(cfg.root, cfg.base, repo.root);
    lines.push(`destination: ${dest.url}  [${dest.kind}]`);
  }

  const remoteUrl = await repo.git.tryOut("remote", "get-url", cfg.remote);
  if (remoteUrl === null) {
    lines.push(`remote:      '${cfg.remote}' NOT SET  (run: git backup init)`);
    healthy = false;
  } else {
    lines.push(`remote:      ${cfg.remote} -> ${remoteUrl}`);
  }

  const registry = await registeredRepos();
  const registered = registry.includes(repo.root);
  lines.push(`registered:  ${registered ? "yes" : "NO  (run: git backup register)"}`);
  if (!registered) healthy = false;
  lines.push(`enabled:     ${cfg.enabled ? "yes" : "no  (backup.enabled=false)"}`);

  const hooks = await hooksInstalled(repo);
  lines.push(`hooks:       ${hooks.length > 0 ? hooks.join(", ") : "none  (run: git backup hooks install)"}`);

  const agent = await agentStatus(cfg.agentLabel);
  lines.push(`agent:       ${agent.loaded ? "loaded" : "NOT LOADED"}  (${cfg.agentLabel})`);
  if (!agent.loaded) healthy = false;

  const now = Math.floor(Date.now() / 1000);
  const buckets = await readBuckets(repo.git, repo.snapKey);
  if (buckets.length === 0) {
    lines.push("snapshots:   none yet");
  } else {
    lines.push("snapshots:");
    for (const b of cfg.buckets) {
      const found = buckets.find((s) => s.bucket === b);
      lines.push(
        found
          ? `  ${b.padEnd(8)} ${found.sha.slice(0, 8)}  ${humanAge(now - found.committed)} ago`
          : `  ${b.padEnd(8)} -`,
      );
    }
  }

  const attic = await listAttic(repo.git);
  if (attic.length > 0) lines.push(`attic:       ${attic.length} preserved tip(s)`);

  if (remoteUrl !== null && cfg.root) {
    const dest = destFor(cfg.root, cfg.base, repo.root);
    const reach = await reachable(repo, cfg, dest);
    lines.push(`reachable:   ${reach.ok ? "yes" : `no - ${reach.reason}`}`);
    if (reach.ok) {
      const refs = await lsRemote(repo.git, cfg.remote);
      lines.push(`unpushed:    ${await unpushedCount(repo, refs)} commit(s)`);
    }
  }

  return { lines, healthy };
}
