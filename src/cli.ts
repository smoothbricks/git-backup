#!/usr/bin/env bun
import { Command } from "commander";
import { VERSION, commandHelp, topLevelHelp } from "./help.ts";
import { preflight } from "./preflight.ts";
import { humanAge, loadConfig } from "./config.ts";
import { Git } from "./git.ts";
import { destFor, findRepo, requireRepo } from "./repo.ts";
import { snapshot } from "./snapshot.ts";
import { runRepo, sweep, type RunOutcome } from "./run.ts";
import { restore } from "./restore.ts";
import { status } from "./status.ts";
import { atticSweep, gcAttic, lsRemote, pushAll, reachable } from "./remote.ts";
import { initRepo, registerPath, registeredRepos, summarize, unregisterPath } from "./registry.ts";
import { installHooks, uninstallHooks } from "./hooks.ts";
import { agentPaths, agentStatus, installAgent, kickAgent, uninstallAgent } from "./agent.ts";

const OK = 0;
const ERR = 1;
const NOTHING = 2;

let quiet = false;
let exitCode = OK;

const say = (...a: unknown[]) => {
  if (!quiet) console.log(...a);
};

type Opts = Record<string, unknown>;
const flag = (o: Opts, name: string) => o[name] === true;

async function cmdInit(o: Opts): Promise<number> {
  await preflight();
  const repo = await requireRepo();
  const r = await initRepo(repo, {
    root: typeof o.root === "string" ? o.root : undefined,
    remote: typeof o.remote === "string" ? o.remote : undefined,
    base: typeof o.base === "string" ? o.base : undefined,
    hooks: o.hooks !== false,
    register: o.register !== false,
  });
  say(`destination: ${r.destUrl}${r.created ? "  (created)" : "  (already present)"}`);
  say(`remote:      ${r.remoteAdded ? "configured" : "unchanged"}`);
  say(`registered:  ${r.registered ? "yes" : "no"}`);
  say(`hooks:       ${r.hooks.length > 0 ? r.hooks.join(", ") : "skipped"}`);
  say("");
  say("Next: git backup run     # snapshot and push now");
  return OK;
}

async function cmdRegister(paths: string[], add: boolean): Promise<number> {
  await preflight();
  const targets = paths.length > 0 ? paths : [(await requireRepo()).root];
  let failed = 0;
  for (const p of targets) {
    const ok = add ? await registerPath(p) : await unregisterPath(p);
    say(`${ok ? (add ? "registered" : "unregistered") : "FAILED"}: ${p}`);
    if (!ok) failed++;
  }
  return failed > 0 ? ERR : OK;
}

async function cmdList(): Promise<number> {
  await preflight();
  const repos = await registeredRepos();
  if (repos.length === 0) {
    say("No repos registered.");
    say("Register one with:  cd <repo> && git backup init");
    return NOTHING;
  }
  for (const path of repos) {
    const s = await summarize(path);
    const age = s.snapAge === null ? "no snapshot" : `snap ${humanAge(s.snapAge)} ago`;
    say(`${s.present ? " " : "!"} ${path}`);
    say(`    ${s.skipReason ? `SKIP (${s.skipReason})` : age}${s.destUrl ? `  ->  ${s.destUrl}` : ""}`);
  }
  return OK;
}

function reportRun(o: RunOutcome): void {
  if (o.snap?.kind === "created") {
    const extra = o.snap.skipped.length > 0 ? `, ${o.snap.skipped.length} skipped` : "";
    say(`snapshot ${o.snap.commit.slice(0, 8)}  +${o.snap.included.length} untracked${extra}`);
    if (o.buckets.length > 0) say(`buckets  ${o.buckets.join(", ")}`);
  } else if (o.snap?.kind === "unchanged") {
    say("snapshot unchanged (tree identical to latest bucket)");
  } else if (o.snap?.kind === "clean") {
    say("worktree clean");
  }
  for (const a of o.attic) say(`attic    ${a.branch}@${a.sha.slice(0, 8)} (${a.why})`);
  if (o.push) say(o.push.ok ? `pushed   ${o.push.updated.length} ref(s)` : `PUSH FAILED: ${o.push.error}`);
  if (o.detail) say(o.detail);
}

async function cmdSnapDryRun(o: Opts): Promise<number> {
  const repo = await requireRepo();
  const cfg = await loadConfig(repo.git);
  const r = await snapshot(repo, cfg, { allFiles: flag(o, "allFiles") });
  if (r.kind !== "created") {
    say(r.kind === "clean" ? "worktree clean - nothing to snapshot" : "no change since last snapshot");
    return NOTHING;
  }
  say(`would include ${r.included.length} untracked file(s):`);
  for (const f of r.included) say(`  + ${f}`);
  if (r.skipped.length > 0) {
    say(`would skip ${r.skipped.length}:`);
    for (const s of r.skipped) say(`  - ${s.path}  (${s.reason})`);
  }
  return OK;
}

async function cmdRun(mode: "snap" | "push" | "run", o: Opts): Promise<number> {
  await preflight();
  if (mode === "snap" && flag(o, "dryRun")) return cmdSnapDryRun(o);

  const out = await runRepo(await requireRepo(), {
    dryRun: flag(o, "dryRun"),
    allFiles: flag(o, "allFiles"),
    snapOnly: mode === "snap",
    pushOnly: mode === "push",
  });
  reportRun(out);
  if (out.status === "error") return ERR;
  return out.status === "backed-up" ? OK : NOTHING;
}

async function cmdSweep(o: Opts): Promise<number> {
  await preflight();
  const { outcomes, locked } = await sweep({ dryRun: flag(o, "dryRun") });
  if (locked) {
    say("another sweep is already running");
    return NOTHING;
  }

  let ok = 0;
  let failed = 0;
  for (const out of outcomes) {
    if (out.status === "backed-up") {
      ok++;
      say(out.path);
      reportRun(out);
    } else if (out.status === "error") {
      failed++;
      console.error(`${out.path}: ${out.detail}`);
    } else if (out.status === "unreachable") {
      say(`${out.path}: unreachable - ${out.detail}`);
    }
  }

  say(`swept ${outcomes.length} repo(s): ${ok} backed up, ${failed} failed`);
  if (failed > 0) return ERR;
  return ok > 0 ? OK : NOTHING;
}

async function cmdPrune(o: Opts): Promise<number> {
  await preflight();
  const repo = await requireRepo();
  const cfg = await loadConfig(repo.git);
  if (!cfg.root) {
    console.error("backup.root not set");
    return ERR;
  }

  const reach = await reachable(repo, cfg, destFor(cfg.root, cfg.base, repo.root));
  if (!reach.ok) {
    console.error(`unreachable: ${reach.reason}`);
    return NOTHING;
  }

  const refs = await lsRemote(repo.git, cfg.remote);
  const vanished: string[] = [];
  for (const ref of refs.keys()) {
    if (!ref.startsWith("refs/heads/")) continue;
    if ((await repo.git.rev(ref)) === null) vanished.push(ref.slice("refs/heads/".length));
  }

  const { saved } = await atticSweep(repo, cfg, refs);
  for (const a of saved) say(`attic ${a.branch}@${a.sha.slice(0, 8)} (${a.why})`);

  if (vanished.length === 0) {
    say("no remote branches without a local counterpart");
    return NOTHING;
  }
  say(`${vanished.length} remote branch(es) with no local counterpart: ${vanished.join(", ")}`);

  if (flag(o, "dryRun")) return OK;
  if (!flag(o, "yes")) {
    say("Refusing to prune without --yes. Their tips are already preserved in the attic.");
    return NOTHING;
  }

  const res = await pushAll(repo, cfg, { prune: true });
  say(res.ok ? `pruned; ${res.updated.length} ref update(s)` : `FAILED: ${res.error}`);
  return res.ok ? OK : ERR;
}

async function cmdGc(o: Opts): Promise<number> {
  await preflight();
  const repo = await requireRepo();
  const cfg = await loadConfig(repo.git);
  const confirmed = flag(o, "yes");
  const r = await gcAttic(repo, cfg, { dryRun: !confirmed });

  if (r.expired.length === 0) {
    say("no attic refs past expiry");
    return NOTHING;
  }
  if (!confirmed) {
    say(`${r.expired.length} attic ref(s) past expiry; re-run with --yes to delete:`);
    for (const ref of r.expired) say(`  ${ref}`);
    return OK;
  }
  say(`expired ${r.expired.length} attic ref(s); destination ${r.remoteDeleted ? "updated" : "NOT updated"}`);
  return OK;
}

async function cmdRestore(bucket: string, paths: string[], o: Opts): Promise<number> {
  await preflight();
  const r = await restore(await requireRepo(), bucket, { all: flag(o, "all"), paths });

  if (r.kind === "missing") {
    console.error(`no snapshot in bucket '${bucket}' (${r.ref})`);
    return ERR;
  }
  if (r.kind === "diff") {
    say(r.output || "(no difference between the worktree and this snapshot)");
    say("");
    say(`Restore with:  git backup restore ${bucket} -- <path>...`);
    say(`Or entirely:   git backup restore ${bucket} --all`);
    return OK;
  }
  say(`restored from ${r.ref}: ${r.paths.join(" ")}`);
  return OK;
}

async function cmdStatus(): Promise<number> {
  await preflight();
  const r = await status(await requireRepo());
  for (const l of r.lines) say(l);
  return r.healthy ? OK : NOTHING;
}

async function cmdAgent(sub: string): Promise<number> {
  // Agent commands are global: they must work from outside any repo, so config
  // is read through a cwd-scoped Git, which falls back to global config.
  const repo = await findRepo();
  const cfg = await loadConfig(repo?.git ?? new Git(process.cwd()));

  switch (sub) {
    case "install": {
      const p = await installAgent({ label: cfg.agentLabel, interval: cfg.interval, startOnMount: true });
      say(`installed ${p.label}`);
      say(`  plist:    ${p.plist}`);
      say(`  log:      ${p.log}`);
      say(`  interval: ${cfg.interval}s, plus on-mount and on-commit`);
      return OK;
    }
    case "uninstall":
      say((await uninstallAgent(cfg.agentLabel)) ? "uninstalled" : "no agent installed");
      return OK;
    case "status": {
      const s = await agentStatus(cfg.agentLabel);
      say(`${cfg.agentLabel}: ${s.loaded ? "loaded" : "not loaded"}`);
      return s.loaded ? OK : NOTHING;
    }
    case "kick":
      // Runs from a git hook. Must never fail, or it blocks a commit.
      await kickAgent(cfg.agentLabel);
      return OK;
    case "log": {
      const f = Bun.file(agentPaths(cfg.agentLabel).log);
      say((await f.exists()) ? await f.text() : "no log yet");
      return OK;
    }
    default:
      console.error(`unknown: git backup agent ${sub}`);
      return ERR;
  }
}

async function cmdHooks(sub: string): Promise<number> {
  await preflight();
  const repo = await requireRepo();
  if (sub === "install") {
    say(`installed: ${(await installHooks(repo)).join(", ")}`);
    return OK;
  }
  if (sub === "uninstall") {
    const removed = await uninstallHooks(repo);
    say(removed.length > 0 ? `removed: ${removed.join(", ")}` : "no git-backup hook blocks found");
    return OK;
  }
  console.error(`unknown: git backup hooks ${sub}`);
  return ERR;
}

function build(): Command {
  const program = new Command();
  program
    .name("git-backup")
    .version(VERSION, "-v, --version")
    .option("-q, --quiet", "suppress informational output")
    .exitOverride();
  program.helpInformation = () => topLevelHelp();

  const sub = (name: string, args = "") => {
    const c = program.command(args ? `${name} ${args}` : name);
    c.helpInformation = () => commandHelp(name) ?? topLevelHelp();
    c.exitOverride();
    return c;
  };

  const run = (fn: () => Promise<number>) => async () => {
    exitCode = await fn();
  };

  sub("init")
    .option("--root <url>", "destination root for this repo")
    .option("--remote <name>", "remote name to create")
    .option("--base <dir>", "local base directory")
    .option("--no-hooks", "do not install git hooks")
    .option("--no-register", "do not add to the maintenance registry")
    .action((o: Opts) => run(() => cmdInit(o))());

  sub("register", "[paths...]").action((p: string[]) => run(() => cmdRegister(p, true))());
  sub("unregister", "[paths...]").action((p: string[]) => run(() => cmdRegister(p, false))());
  sub("list").action(run(cmdList));

  sub("snap")
    .option("--all-files", "bypass the untracked allowlist")
    .option("--dry-run", "report what would be captured, change nothing")
    .action((o: Opts) => run(() => cmdRun("snap", o))());

  sub("push")
    .option("--dry-run", "report what would be pushed")
    .action((o: Opts) => run(() => cmdRun("push", o))());

  sub("run")
    .option("--dry-run", "report what would happen")
    .option("--all-files", "bypass the untracked allowlist")
    .action((o: Opts) => run(() => cmdRun("run", o))());

  sub("sweep")
    .option("--dry-run", "report what would happen")
    .action((o: Opts) => run(() => cmdSweep(o))());

  sub("prune")
    .option("--yes", "actually delete the remote branches")
    .option("--dry-run", "report what would be pruned")
    .action((o: Opts) => run(() => cmdPrune(o))());

  sub("gc")
    .option("--yes", "actually delete expired attic refs")
    .action((o: Opts) => run(() => cmdGc(o))());

  sub("restore", "<bucket> [paths...]")
    .option("--all", "restore every path present in the snapshot")
    .action((b: string, p: string[], o: Opts) => run(() => cmdRestore(b, p, o))());

  sub("status").action(run(cmdStatus));
  sub("agent", "<subcommand>").action((s: string) => run(() => cmdAgent(s))());
  sub("hooks", "<subcommand>").action((s: string) => run(() => cmdHooks(s))());

  sub("help", "[command]").action((c?: string) => {
    console.log(c ? (commandHelp(c) ?? `Unknown command '${c}'.\n\n${topLevelHelp()}`) : topLevelHelp());
    exitCode = OK;
  });

  return program;
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  if (argv.length === 0) {
    console.log(topLevelHelp());
    process.exit(OK);
  }

  quiet = argv.includes("-q") || argv.includes("--quiet");

  try {
    await build().parseAsync(Bun.argv);
    process.exit(exitCode);
  } catch (e) {
    if (e instanceof Error && "code" in e) {
      const code = e.code;
      if (code === "commander.helpDisplayed" || code === "commander.help" || code === "commander.version") {
        process.exit(OK);
      }
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(ERR);
  }
}

await main();
