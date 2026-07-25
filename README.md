# git-backup

Mirror your git repositories to a backup destination, and snapshot the work you have not
committed yet. Committed history goes to a bare mirror on a disk or a server. Uncommitted
history — the half-finished refactor, the debug prints, the file you have not `git add`ed —
is captured into a tiny generational ladder of refs that never touches HEAD, your index,
your worktree or your stash. A launchd agent runs it every five minutes and on volume mount,
git hooks kick it after every commit, and the registry it walks is the one `git maintenance`
already keeps. Installed as `git-backup` on `PATH`, so git finds it as `git backup`.

## What it does

Two independent streams reach the destination.

| | Committed work | Uncommitted work |
|---|---|---|
| Source | `refs/heads/*`, `refs/tags/*` | dirty worktree + allowlisted untracked files |
| Destination refs | mirrored `refs/heads/*`, `refs/tags/*`, plus `refs/backup/attic/<branch>/<sha>` | `refs/backup/snap/<host>/<worktree>/{latest,hourly,daily,weekly}` |
| Retention | unbounded — nothing is deleted without going through the attic first | generational — exactly 4 refs, oldest rotates out |
| Written by | `git backup push` | `git backup snap` |
| Touches the network | yes | no |
| Touches your worktree | no | no |

The two are orthogonal. Committed work is safe because it is mirrored; uncommitted work is
safe because it is snapshotted. Neither stream can lose the other's data.

## Install

### Nix flake with the home-manager module

The flake exposes `packages.<system>.default`, `apps.<system>.default`, `overlays.default`
and `homeManagerModules.default` (also available as `homeManagerModules.git-backup`). The
module owns the launchd agent, so you do not run `git backup agent install` yourself.

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    git-backup.url = "github:danny/git-backup";
    git-backup.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, home-manager, git-backup, ... }: {
    homeConfigurations."danny" = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.aarch64-darwin;
      modules = [
        git-backup.homeManagerModules.default
        {
          home.username = "danny";
          home.homeDirectory = "/Users/danny";
          home.stateVersion = "24.11";

          services.git-backup = {
            enable = true;
            root = "/Volumes/Backup/Dev";   # or "ssh://host/srv/backup"
            base = "/Users/danny/Dev";
            interval = 300;
          };
        }
      ];
    };
  };
}
```

`root` is required when the module is enabled; an assertion catches an empty one at build
time. `base` defaults to `${config.home.homeDirectory}/Dev`. The remaining options mirror the
config keys one for one — `remote`, `buckets`, `wipInclude`, `wipIncludeName`, `wipMaxSize`,
`attic`, `atticExpire`, `startOnMount`, `logFile`, `extraConfig`, plus `package` if you want
to override the derivation. `buckets`, `wipInclude` and `wipIncludeName` are Nix lists and
are joined with spaces into git config for you.

The module writes `backup.agentLabel` automatically, because a home-manager launchd job is
labelled `org.nix-community.home.git-backup`, not the imperative default. That is what lets
the git hooks kick the right job.

The nix package wraps the binary so `git` on its `PATH` is the nixpkgs git. This is about
determinism, not features. Under launchd the `PATH` is bare
(`/usr/bin:/bin:/usr/sbin:/sbin`), and `/usr/bin/git` on macOS is an `xcrun` shim whose
resolved version depends on the environment it is invoked from — the same absolute path
answered 2.54.0 from an interactive shell and 2.50.1 under `env -i` on this machine, and it
can prompt for a Command Line Tools install when CLT is absent. Pinning git removes both
surprises. Every git feature the tool uses works fine on the shim's version; see
[Troubleshooting](#troubleshooting).

### Manual

One self-contained binary is the whole install: `bun build --compile` links the runtime and
the single npm dependency (`commander`) into the executable, so nothing needs to be
installed alongside it.

```bash
git clone https://github.com/danny/git-backup && cd git-backup
bun install                       # commander, plus @types/bun and typescript to build
bun run build                     # bun build --compile --outfile git-backup src/cli.ts
install -m 755 git-backup ~/.local/bin/git-backup
```

Anywhere on `PATH` works. Because the name starts with `git-`, git discovers it and
`git backup <cmd>` becomes an alias for `git-backup <cmd>` at no extra cost.

Build the binary for the machine you are on. Do not pass `--target`: cross-compiling makes
bun fetch a runtime for the other platform, which defeats the offline build. The flake pins
its own bun through nvfetcher rather than taking nixpkgs' version; bump it with:

```bash
nix shell nixpkgs#nvfetcher -c nvfetcher -o _sources
```

Then install the agent:

```bash
git backup agent install
git backup agent status
```

If you go this route the launchd label is `dev.gitbackup.sweep`, and the binary must be
findable from the bare launchd `PATH` — either install it somewhere in `/usr/local/bin`, or
let `agent install` write the absolute path it was invoked as. Verify with
`git backup agent status`.

## Quick start

```bash
git config --global backup.root /Volumes/Backup/Dev   # or ssh://host/srv/backup
git backup agent install
cd ~/Dev/myrepo && git backup init
```

That is the whole setup. `init` creates the destination bare repo, adds the `backup` remote,
registers the repo, and installs the hooks. It is idempotent — re-run it whenever you change
configuration.

Every command has a detailed page, and `git backup help` on its own prints the overview,
the quick start, the registry explanation and the full configuration table:

```bash
git backup help
git backup help restore
git backup help agent
```

## Registering repos

There is no private registry. git-backup reads exactly the list `git maintenance` keeps:

```bash
git config --global --get-all maintenance.repo
```

`git backup init` calls `git maintenance register`, which appends the repo to that list.
`git backup sweep` iterates it and silently skips any repo with no `backup` remote or with
`backup.enabled=false`. One registry, two tools — deliberate piggybacking, so you never have
two lists of "repos I care about" drifting apart.

What follows from that:

- A repo **already registered for `git maintenance`** needs nothing but a `backup` remote to
  start being swept. Run `git backup init` in it, or add the remote by hand.
- `git backup register <path>...` adds repos to the registry **without** creating a
  destination or touching hooks. Use it to adopt repos in bulk, then run `git backup init` in
  each one when you are ready to give it a destination.
- `git backup list` prints the registry with each repo's destination, snapshot age and last
  push, so you can see at a glance what is actually covered.
- `git backup unregister <path>...` takes a repo out of the sweep entirely. Nothing already
  pushed is deleted — only the schedule stops.
- To keep a repo registered for maintenance but stop backing it up, set
  `git config backup.enabled false` inside it. `git maintenance run` still services it;
  `git backup sweep` skips it.

Adopting everything under `~/Dev` at once:

```bash
for r in ~/Dev/*/.git; do git backup register "$(dirname "$r")"; done
git backup list
```

Registering does not back a repo up on the spot. The next sweep does, or run
`git backup run` to do it now.

## How snapshots work

`git backup snap` builds a real commit out of your dirty worktree, without disturbing
anything you are in the middle of.

The snapshot is assembled in a **temporary `GIT_INDEX_FILE`**, then `git write-tree` and
`git commit-tree` turn it into an object. HEAD is not moved. Your index is not staged into.
Your worktree is not modified. Your stash is not pushed to. Running `snap` halfway through a
rebase, or with a conflicted merge in progress, is safe and captures exactly that state.

Untracked files are **allowlisted, not gitignore-filtered**. That is the important design
decision. Filtering by `.gitignore` means every file you have not gotten around to ignoring
yet is a candidate for the backup — the 400MB `target/` directory you created two minutes
ago goes over the network before `.gitignore` catches up. An allowlist inverts the failure
mode: the worst case is that a file you wanted is missing, not that a file you never wanted
is copied to a network destination forever.

Three gates, all of which must pass:

1. **Name.** The path matches a glob in `backup.wipInclude`, or its basename is listed in
   `backup.wipIncludeName`, or it matches a pattern in the file named by
   `backup.wipIncludeFile` (one pattern per line, `#` starts a comment).
2. **Size.** The file is no larger than `backup.wipMaxSize`, default `1m`.
3. **Content.** It sniffs as text, not binary.

`--all-files` bypasses gate 1 for a one-off run. It is not something to wire into the agent.

Finally, the **tree-hash skip**: if the tree the snapshot would produce is byte-identical to
the tree of the current `latest` bucket, nothing has changed since the last snapshot. `snap`
writes no ref and exits 2. No commit object, no rotation, and — because `run` has nothing new
to offer — no network traffic. This is why a five-minute interval across a hundred repos
costs nothing when you are not typing.

The ref name carries both the host and the worktree:
`refs/backup/snap/<host>/<worktree>/<bucket>`. `<worktree>` is `_main` for the repo's main
worktree and git's own worktree id — the directory name under `.git/worktrees/` — for a
linked one. The depth is the same either way, so on host `DM5` the main checkout writes
`refs/backup/snap/DM5/_main/hourly` and a `feature` worktree writes
`refs/backup/snap/DM5/feature/hourly`.

(There is no `~` anywhere in these refs. `~` is revision syntax and `git check-ref-format`
rejects it, so a separator like `<host>~<worktree>` would make `update-ref` fail.)

Every worktree of a repo therefore gets its own independent bucket ladder, because
uncommitted work is inherently per-worktree — while all of them share one destination, one
set of branches and one set of tags. See [Destinations](#destinations).

## The bucket ladder

`backup.buckets` is `latest hourly daily weekly`, with ages 0, 1h, 24h and 7d.

Each snapshot writes `latest`. Before it does, `latest` rotates down into `hourly` if the
existing `hourly` is older than an hour, `hourly` into `daily` if `daily` is older than a
day, `daily` into `weekly` if `weekly` is older than a week.

The guarantee: **at any instant you hold a snapshot from ≤5 minutes ago, ≤1 hour ago, ≤1 day
ago and ≤1 week ago — in exactly four refs.** Not four per day. Four, total, forever. A
naive "snapshot every five minutes" scheme accumulates 288 refs a day and 105,000 a year;
this one has a fixed footprint, which is what makes it safe to run on every repo you own
without ever thinking about it again.

A snapshot that rotates out simply stops being referenced. Locally it becomes unreachable and
is reclaimed whenever ordinary `gc.auto` next runs — no special expiry logic, no cleanup
command to remember.

On the destination it is a different story, and deliberately so. Destination repos we create
get `gc.auto=0`, so nothing is ever collected there automatically. The bare repo therefore
retains considerably more history than the four buckets promise: every snapshot you ever
pushed is still there as a dangling object, recoverable with `git fsck --lost-found`. The
ladder is the guarantee; the destination is usually more generous than the guarantee.

## Recovery

Start by looking, not restoring. With no paths and no `--all`, `restore` only prints a diff:

```bash
git backup restore hourly
```

Then take back what you want:

```bash
git backup restore hourly -- src/foo.ts       # one file from an hour ago
git backup restore daily --all                # yesterday's whole snapshot
git backup restore daily --all --yes          # ...without the confirmation prompt
```

`--all` is deliberately non-destructive. It runs `git restore --source=<ref> -- .`, which
rewrites the paths the snapshot contains but does **not** delete files you created after the
snapshot was taken. Restoring never removes anything from your worktree; the worst it does is
overwrite a path that also exists in the snapshot.

Nothing here is magic, and nothing requires this tool. The refs are ordinary refs and plain
git reaches them:

```bash
git diff refs/backup/snap/$(hostname -s)/_main/daily                  # what changed since
git restore --source=refs/backup/snap/$(hostname -s)/_main/hourly -- src/foo.ts
git log --oneline refs/backup/snap/$(hostname -s)/_main/latest        # snapshot commits
git show refs/backup/snap/$(hostname -s)/_main/weekly:src/foo.ts      # just read one file
```

In a linked worktree, substitute git's worktree id for `_main`. To see what actually exists:

```bash
git for-each-ref refs/backup/snap
```

To go further back than the four buckets, use the destination. Because destinations have
`gc.auto=0`, rotated-out snapshots are still there as dangling commits:

```bash
git clone /Volumes/Backup/Dev/myrepo.git recovered && cd recovered
git fsck --lost-found                  # dangling commit <sha> ...
git show <sha>
```

Do this in a clone, not in the destination itself.

## Attic and prune

**Deleting a local branch does not destroy its backup.** When `git backup prune` finds a
branch on the destination with no local counterpart, it first copies the tip to
`refs/backup/attic/<branch>/<shortsha>` and only then deletes the branch. The commits stay
reachable through the attic ref. The same applies to a force-push that would overwrite a
remote tip: the old tip is preserved first.

```bash
git backup prune --dry-run             # what would be retired
git backup prune --yes
git for-each-ref refs/backup/attic     # what has been retired so far
```

Attic refs are not kept forever. `git backup gc` deletes those older than
`backup.atticExpire` (default `90d`), which makes their commits unreachable and eligible for
ordinary collection:

```bash
git backup gc                          # prompts, listing what it will drop
git backup gc --yes
git config --global backup.atticExpire 30d
```

Setting `backup.attic=false` skips the preservation step and deletes outright. It is the only
way to lose data through `prune`, and it is off by default.

## Configuration

All keys live under `backup.*` in git config. A per-repo local value overrides the global
one, and the environment variables `GIT_BACKUP_LABEL`, `GIT_BACKUP_ROOT` and
`GIT_BACKUP_BASE` override both.

| Key | Default | Meaning |
|---|---|---|
| `backup.root` | *(required)* | Destination root. `/Volumes/Backup/Dev`, `ssh://host/srv/bk`, `host:/srv/bk` |
| `backup.base` | `$HOME/Dev` | Local prefix stripped to compute the relative destination path |
| `backup.remote` | `backup` | Remote name |
| `backup.buckets` | `latest hourly daily weekly` | Generational ladder; ages 0 / 1h / 24h / 7d |
| `backup.wipInclude` | see below | Space-separated globs of untracked files to include |
| `backup.wipIncludeName` | see below | Exact basenames to include (`Makefile`, `.envrc`, ...) |
| `backup.wipIncludeFile` | *(none)* | Repo-relative file of extra patterns, `#` comments |
| `backup.wipMaxSize` | `1m` | Per-file size cap for untracked files |
| `backup.attic` | `true` | Preserve overwritten remote tips |
| `backup.atticExpire` | `90d` | Age at which `gc` drops attic refs |
| `backup.agentLabel` | `dev.gitbackup.sweep` | launchd label the hooks kick |
| `backup.interval` | `300` | Agent `StartInterval`, in seconds |
| `backup.enabled` | `true` | Per-repo opt-out |

The untracked-file allowlist defaults to source-shaped things: common source and config
extensions for `backup.wipInclude`, and extensionless files that are almost always worth
keeping for `backup.wipIncludeName` (`Makefile`, `Dockerfile`, `.envrc`, and similar).
Inspect what your settings actually admit with:

```bash
git backup snap --dry-run
```

Extending the allowlist:

```bash
git config --global --add backup.wipInclude '*.sql'
git config backup.wipIncludeFile .backupinclude    # per-repo pattern file
git config --global backup.wipMaxSize 4m
```

## Destinations

`backup.root` accepts a local path, an `ssh://` URL, or scp-style `host:/path`. The
destination for a repo is its path relative to `backup.base`, hung off the root, with a
`.git` suffix:

| Local repo | `backup.base` | `backup.root` | Destination |
|---|---|---|---|
| `~/Dev/myrepo` | `~/Dev` | `/Volumes/Backup/Dev` | `/Volumes/Backup/Dev/myrepo.git` |
| `~/Dev/work/api` | `~/Dev` | `/Volumes/Backup/Dev` | `/Volumes/Backup/Dev/work/api.git` |
| `~/Dev/myrepo` | `~/Dev` | `ssh://host/srv/bk` | `ssh://host/srv/bk/myrepo.git` |
| `/opt/src/thing` | `~/Dev` | `/Volumes/Backup/Dev` | `/Volumes/Backup/Dev/opt/src/thing.git` |

Nesting is preserved rather than flattened to a basename, so `~/Dev/a/api` and `~/Dev/b/api`
cannot collide. A repo outside `backup.base` falls back to its absolute path with the leading
slash stripped, for the same reason.

A **linked worktree** resolves to its main repository's destination — the path comes from
`git rev-parse --git-common-dir`, not `--show-toplevel`. The destination therefore holds
exactly one bare repo per repository, never one directory per worktree, and every checkout
of that repo reports the same remote URL. Worktrees are distinguished inside the snapshot
ref name instead, as described in [How snapshots work](#how-snapshots-work).

What `init` does differs by destination type:

- **Local path** — `git init --bare <dest>`, creating parent directories as needed.
- **ssh** — the same `git init --bare` executed over ssh on the remote host.

On destinations it creates, `init` sets two things:

```ini
receive.unpackLimit = 1
gc.auto = 0
```

`receive.unpackLimit=1` makes every push land as a **single packfile** instead of exploding
into loose objects. Over SMB, NFS or sshfs this is the difference between one file write and
several thousand round-trips per push; it is the single most important setting on a
network-mounted destination. `gc.auto=0` means the destination never garbage-collects behind
your back, which is what leaves rotated-out snapshots recoverable via `git fsck --lost-found`.

Neither is forced on a destination you created yourself. If you are pointing `backup.root` at
a pre-existing bare repo, set them by hand.

## Interop with git-auto-remote

The two tools are designed to share a repo.

**Pushes.** `git backup push` uses `--no-verify`. A backup remote legitimately holds
histories that are disjoint from your other remotes — that is the entire point of an attic —
and git-auto-remote installs a `pre-push` guard that rejects cross-history pushes. Skipping
hook verification for a push the tool itself initiated is the same convention git-auto-remote
uses for its own sanctioned pushes, so the guard keeps protecting your manual pushes while
backups get through.

**Hooks.** `git backup hooks install` appends a fenced block marked with a sentinel comment
rather than overwriting the hook file, and re-running it replaces that block instead of
duplicating it. `hooks uninstall` removes only git-backup's block. Because git-auto-remote
follows the same chainable convention, both tools' blocks coexist in one `post-commit`:

```bash
cat .git/hooks/post-commit
```

## Troubleshooting

**The agent is not running.**

```bash
git backup agent status     # plist present? loaded? last exit status?
git backup agent log        # tail ~/Library/Logs/git-backup.log
git backup agent kick       # force a sweep now
```

If `status` says the plist exists but launchd does not have it loaded, re-run
`git backup agent install`. Under home-manager, do not run `agent install` at all — run
`home-manager switch` and let the module own the job.

**The destination is unreachable.** Exit code 2, not 1. This is normal and not an error: an
unmounted backup volume or a sleeping ssh host should not turn the launchd log red. The next
sweep picks up where this one left off, and `StartOnMount` means plugging the drive back in
triggers a sweep immediately.

```bash
git backup status           # resolved destination + whether it is reachable
git backup push --dry-run   # what would be pushed once it comes back
```

**Nothing is being snapshotted.** Almost always the allowlist. Check what it admits and what
it rejects:

```bash
git backup snap --dry-run
```

Remember the three gates: name, size (`backup.wipMaxSize`), and the binary sniff. A file that
is in the allowlist but 4MB with a 1MB cap is silently skipped. If the tree has not changed
since the last snapshot, `snap` exits 2 and writes nothing — that is the tree-hash skip
working, not a failure.

**The hook fires but nothing happens.** The label the hook kicks and the label the agent is
installed under have to match. The imperative install uses `dev.gitbackup.sweep`;
home-manager uses `org.nix-community.home.git-backup`. If you moved from one to the other,
the hooks are still kicking the old label:

```bash
git config --global backup.agentLabel        # what the hooks kick
launchctl list | grep -i git-backup          # what is actually loaded
git config --global backup.agentLabel org.nix-community.home.git-backup
```

The home-manager module sets `backup.agentLabel` for you, so this only bites if a stale local
override in a repo is shadowing the global value — check with
`git config --local backup.agentLabel`.

**A repo is not being swept.** `git backup status` reports every reason at once: not in the
registry, no `backup` remote, `backup.enabled=false`, or an unreachable destination.

```bash
git backup list             # registry + per-repo status
git backup status           # this repo, in detail
git backup sweep --dry-run --verbose
```

**Is the launchd git too old?** No — and this is worth stating plainly, because it is the
obvious worry. The highest requirement the tool has is `git rev-parse
--path-format=absolute`, which puts the floor at **git 2.31**. Every git feature git-backup
uses, `git maintenance register` included, was verified against Apple's `/usr/bin/git`
2.50.1 under a clean `env -i` environment. The nix wrapper exists for determinism, not
because the system git lacks anything.

git-backup preflights this at startup anyway: it resolves `git` on `PATH`, checks the
version against `>=2.31.0`, and exits 1 with an explicit message if it is unmet. So a
version problem announces itself rather than surfacing as a strange failure three commands
later.

```bash
git --version                                  # what your shell resolves
env -i PATH=/usr/bin:/bin git --version        # what launchd will resolve
```
