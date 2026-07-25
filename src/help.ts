/**
 * Help text and version metadata.
 *
 * Deliberately dependency-free and import-free: this module is pulled into the
 * compiled binary and its output is frequently redirected into a launchd log,
 * so there is no ANSI colour and no terminal-width detection here. Every line
 * is kept under 100 columns so the text survives a narrow terminal unwrapped.
 */

export const VERSION = "0.1.0";

const CONFIG_TABLE = `
  backup.root             (required)              Destination root. A local path
                                                  (/Volumes/Backup/Dev), an ssh URL
                                                  (ssh://host/srv/backup) or scp-style
                                                  syntax (host:/srv/backup).
  backup.base             $HOME/Dev               Local prefix stripped to compute the
                                                  relative destination path.
  backup.remote           backup                  Remote name used for the destination.
  backup.buckets          latest hourly daily weekly
                                                  Generational ladder, ages 0 / 1h / 24h / 7d.
  backup.wipInclude       see README              Space-separated globs of untracked files
                                                  to include in a snapshot.
  backup.wipIncludeName   see README              Exact basenames to include
                                                  (Makefile, .envrc, ...).
  backup.wipIncludeFile   (none)                  Repo-relative file of extra patterns,
                                                  one per line, '#' starts a comment.
  backup.wipMaxSize       1m                      Per-file size cap for untracked files.
  backup.attic            true                    Preserve remote tips before they are
                                                  overwritten or deleted.
  backup.atticExpire      90d                     Age at which 'gc' drops attic refs.
  backup.agentLabel       dev.gitbackup.sweep     launchd label that the git hooks kick.
  backup.interval         300                     Agent StartInterval, in seconds.
  backup.enabled          true                    Per-repo opt-out; set false to skip.

  Per-repo local config overrides global config. Three environment variables win over
  both: GIT_BACKUP_LABEL, GIT_BACKUP_ROOT, GIT_BACKUP_BASE.`;

/** The standalone overview shown by 'git backup', 'git backup help' and '--help'. */
export function topLevelHelp(): string {
  return `git-backup ${VERSION} - mirror your repos and snapshot the work you have not committed yet

usage: git backup <command> [<args>]
       git-backup <command> [<args>]

Two independent streams reach the destination. Committed work is mirrored as
refs/heads/* and refs/tags/*. Uncommitted work is captured into a small
generational ladder of snapshot refs that never touches HEAD, the index, the
worktree or the stash.

Setup
  init          Create the destination repo, add the remote, register, install hooks
  register      Register existing repo(s) with the registry that sweep walks
  unregister    Remove repo(s) from that registry
  list          List registered repos with per-repo backup status

Backup
  snap          Snapshot the dirty worktree into local bucket refs; no network
  push          Push heads, tags, snapshot buckets and attic refs
  run           snap + push for the current repo
  sweep         run over every registered repo; this is the launchd entrypoint

Recovery
  restore       Show the diff against a bucket, or restore files from it
  status        Diagnostics for the current repo

Maintenance
  prune         Copy orphaned remote branch tips into the attic, then delete them
  gc            Expire attic refs older than backup.atticExpire

System
  agent         launchd agent: install | uninstall | status | kick | log
  hooks         Repo hooks: install | uninstall
  help          Show help for a command

Global flags
  -v, --verbose      Echo every git command that is run, to stderr, prefixed
                     '+ git ...', so it never contaminates parseable stdout
  -q, --quiet        Suppress everything but errors
  -V, --version      Print the version and exit
  -h, --help         Show this help, or the page for the given command
  --no-interactive   Never prompt. Fail with the instructions instead, so a
                     script or a CI job can never hang waiting for input.

QUICK START

  # Answer three questions - destination, local base, sweep interval - then the
  # agent is installed. This is the whole setup.
  git backup agent install

  # Wire up a repo. Creates the destination, adds the remote, registers,
  # installs hooks. Idempotent, so re-running it is always safe.
  cd ~/Dev/myrepo && git backup init

  Prefer to skip the questions? Set the destination first and neither command
  asks anything:

      git config --global backup.root /Volumes/Backup/Dev   # or ssh://host/srv/bk
      git backup agent install
      cd ~/Dev/myrepo && git backup init

  After that there is nothing to do by hand. The agent sweeps on its interval and
  on volume mount, and the hooks kick it immediately after a commit, rebase,
  checkout or merge.

  'sweep' and 'agent kick' never prompt under any circumstances, so a scheduled
  run or a git hook cannot hang.

REGISTERING MORE REPOS

  There is no private registry. git-backup reads exactly the list that
  'git maintenance' keeps:

      git config --global --get-all maintenance.repo

  'git backup init' calls 'git maintenance register', which appends the repo to
  that list. 'git backup sweep' iterates it and silently skips any repo that has
  no 'backup' remote or that has backup.enabled=false. One registry, two tools.

  Consequences worth knowing:

    - A repo you already registered for 'git maintenance' needs nothing but a
      'backup' remote to start being swept. Run 'git backup init' in it, or add
      the remote yourself.
    - 'git backup register <path>...' adds repos to the registry WITHOUT creating
      a destination or touching hooks. Use it to adopt repos in bulk, then run
      'git backup init' in each one when you are ready to give it a destination.
    - 'git backup list' prints the registry with each repo's destination, last
      push and snapshot age, so you can see at a glance what is actually covered.
    - 'git backup unregister <path>...' takes a repo out of the sweep entirely.
      To keep it registered for maintenance but stop backing it up, set
      'git config backup.enabled false' inside the repo instead.
    - Registering a repo does not back it up on the spot. The next sweep does, or
      run 'git backup run' to do it now.

  Adopting everything under ~/Dev at once:

      for r in ~/Dev/*/.git; do git backup register "$(dirname "$r")"; done
      git backup list

CONFIGURATION

  Read with 'git config backup.<key>', set globally with
  'git config --global backup.<key> <value>', override per repo by setting the
  same key without --global inside that repo.
${CONFIG_TABLE}

EXIT CODES

  0 success   1 error   2 nothing to do (a clean worktree, or an unreachable
  destination). Exit 2 is not a failure; sweep and snap use it so a detached
  backup volume never turns into a red launchd log.

See 'git backup help <command>' for detail on a command.`;
}

const PAGES: Record<string, string> = {
  init: `git backup init - create the destination repo and wire this repo up to it

usage: git backup init [--root <url>] [--remote <name>] [--base <dir>]
                       [--no-hooks] [--no-register]

Prepares the current repository for backup. Every step is idempotent, so re-run
it freely after changing configuration or moving the destination.

If backup.root is not configured and no --root was given, init offers to set it
up interactively rather than failing: it asks for the destination root, the local
base directory and the sweep interval, shows you the exact 'git config --global'
lines it is about to write, and only writes them once you agree. Passing --root
skips the wizard entirely, as does --no-interactive, which fails with the manual
commands instead of asking.

  1. Works out the destination: the repo's path relative to backup.base, hung
     off backup.root, with a .git suffix. A repo outside backup.base maps to its
     absolute path with the leading slash stripped, so the mapping stays
     collision-free instead of flattening everything to a basename.
  2. Creates that bare repo if it is missing. Locally that is 'git init --bare';
     for an ssh root the same thing runs over ssh.
  3. Sets receive.unpackLimit=1 and gc.auto=0 on destinations it creates, so each
     push lands as a single packfile and nothing is expired behind your back.
  4. Adds or updates the 'backup' remote to point at it.
  5. Runs 'git maintenance register' so 'git backup sweep' will visit this repo.
  6. Installs the post-commit, post-rewrite, post-checkout and post-merge hooks,
     which kick the launchd agent.

flags
  --root <url>     Destination root for this repo. Also written to the repo's
                   local backup.root. Defaults to the configured backup.root.
                   Supplying it skips the interactive setup.
  --remote <name>  Remote name to create. Default: backup
  --base <dir>     Local prefix stripped to compute the relative destination
                   path. Default: backup.base, else $HOME/Dev
  --no-hooks       Skip hook installation. Sweeps still cover the repo; only the
                   immediate post-commit kick is lost.
  --no-register    Do not touch the maintenance registry. The repo gets a
                   destination and a remote but is not swept automatically.

examples
  git backup init                    # asks for a destination if none is set yet
  git config --global backup.root /Volumes/Backup/Dev    # ...or set it up front
  cd ~/Dev/myrepo && git backup init
  # ~/Dev/myrepo         ->  /Volumes/Backup/Dev/myrepo.git
  # ~/Dev/work/api       ->  /Volumes/Backup/Dev/work/api.git
  # /opt/src/thing       ->  /Volumes/Backup/Dev/opt/src/thing.git   (outside base)

  # Run from a linked worktree and you get the main repo's destination, not a
  # second one: the path is resolved with --git-common-dir, so the destination
  # holds exactly one bare repo per repo, never one directory per worktree.

  # A single repo that belongs on a different destination than the global one:
  git backup init --root ssh://backup.example.net/srv/git --remote offsite`,

  register: `git backup register - add repos to the registry that sweep walks

usage: git backup register [<path>...]

Registers each path (default: the repository containing the current directory)
by appending it to the global maintenance.repo list, the same list that
'git maintenance register' writes. It does not create a destination, add a
remote or install hooks; use 'git backup init' for that.

Registering the same repo twice is a no-op. A registered repo with no 'backup'
remote is silently skipped by sweep, so it is safe to register broadly and wire
destinations up later.

flags
  (none beyond the global flags)

examples
  git backup register                       # the repo containing the CWD
  git backup register ~/Dev/api ~/Dev/web   # several at once

  # Adopt every repo under ~/Dev, then see what is covered:
  for r in ~/Dev/*/.git; do git backup register "$(dirname "$r")"; done
  git backup list`,

  unregister: `git backup unregister - remove repos from the registry that sweep walks

usage: git backup unregister [<path>...]

Removes each path (default: the repository containing the current directory)
from the global maintenance.repo list. Nothing else is touched: the destination
repo, the 'backup' remote, the installed hooks and every ref already pushed all
survive. Only the automatic sweep stops.

To keep a repo registered for 'git maintenance' but stop backing it up, set
'git config backup.enabled false' in the repo instead; sweep will skip it while
'git maintenance run' still services it.

flags
  (none beyond the global flags)

examples
  cd ~/Dev/scratch && git backup unregister
  git backup unregister ~/Dev/old-experiment

  # Stop backing up without leaving the maintenance registry:
  cd ~/Dev/huge-monorepo && git config backup.enabled false`,

  list: `git backup list - show the registered repos and their backup status

usage: git backup list

Prints every repo in the global maintenance.repo list together with its
destination, whether it has a 'backup' remote, whether backup.enabled is set,
how old the newest snapshot bucket is and when the last successful push
happened. This is the fastest way to answer "is this actually being backed up?".

Repos that sweep will skip are marked as such: no 'backup' remote configured, or
backup.enabled=false.

flags
  (none beyond the global flags)

examples
  git backup list
  git backup list | grep -v ' ok '     # only the repos that need attention`,

  snap: `git backup snap - snapshot the dirty worktree into local bucket refs

usage: git backup snap [--all-files] [--dry-run]

Captures uncommitted work as a real commit under
refs/backup/snap/<host>/<worktree>/<bucket>, then rotates the bucket ladder.
Purely local: snap never talks to the network.

<worktree> is '_main' for the repo's main worktree, and git's own worktree id
(the directory name under .git/worktrees/) for a linked one - so a 'feature'
worktree on host DM5 writes refs/backup/snap/DM5/feature/hourly while the main
checkout writes refs/backup/snap/DM5/_main/hourly. Same depth either way.

Every worktree of a repo therefore keeps its own independent bucket ladder,
because uncommitted work is per-worktree, while all of them share one
destination and one set of branches and tags.

The snapshot is built in a temporary GIT_INDEX_FILE with 'git write-tree' and
'git commit-tree'. HEAD, your index, your worktree and your stash are never
touched, so it is safe to run mid-rebase or mid-merge.

Untracked files are allowlisted rather than gitignore-filtered, so a build
artifact cannot ride into the backup just because .gitignore has not caught up
with it yet. Three gates, all of which must pass:

  1. The path matches backup.wipInclude (globs), backup.wipIncludeName (exact
     basenames), or a pattern in backup.wipIncludeFile.
  2. The file is no larger than backup.wipMaxSize (default 1m).
  3. The content sniffs as text, not binary.

If the resulting tree hash equals the tree of the current 'latest' bucket,
nothing has changed and snap exits 2 without writing a ref.

flags
  --all-files   Bypass the allowlist and include every untracked file that is not
                ignored by git. Still subject to backup.wipMaxSize. Use once, on
                purpose; do not wire it into the agent.
  --dry-run     List exactly what would be snapshotted and which files the
                allowlist rejected, then exit without writing refs.

exit codes
  0 a snapshot was written   2 clean worktree, or the tree was unchanged

examples
  git backup snap
  git backup snap --dry-run          # audit the allowlist decisions
  git backup snap --all-files        # one-off: grab everything untracked`,

  push: `git backup push - push heads, tags, snapshot buckets and attic refs

usage: git backup push [--dry-run]

Pushes to the 'backup' remote (or backup.remote): refs/heads/*, refs/tags/*, the
snapshot buckets under refs/backup/snap/<host>/<worktree>/*, and the tips under
refs/backup/attic/*. Snapshot buckets are force-updated, because rotation
rewrites them by design.

Before pushing, push probes the destination. If it is unreachable - an unmounted
backup volume, an ssh host that is asleep - it exits 2 rather than failing, so a
detached destination never shows up as an error in the agent log.

Pushes are made with --no-verify. Backup remotes legitimately hold histories
that are disjoint from your other remotes, and a cross-history pre-push guard
(git-auto-remote installs one) would otherwise reject them.

flags
  --dry-run   Show the refspecs that would be pushed, including which snapshot
              buckets are force-updated, without contacting the destination.

exit codes
  0 pushed   2 destination unreachable, or nothing to push

examples
  git backup push
  git backup push --dry-run
  git backup push --verbose          # echo the underlying git push`,

  run: `git backup run - snapshot and push the current repo

usage: git backup run [--dry-run]

Equivalent to 'git backup snap' followed by 'git backup push', for the repo
containing the current directory. This is what you run when you want a backup
right now instead of waiting for the agent.

A clean worktree is not a reason to skip the push: committed work that has not
reached the destination yet is still pushed. run exits 2 only when there is
genuinely nothing to do, or when the destination is unreachable.

flags
  --dry-run   Pass through to both phases: show the snapshot that would be taken
              and the refspecs that would be pushed, without changing anything.

exit codes
  0 something was backed up   2 nothing to do, or destination unreachable

examples
  git backup run
  git backup run --dry-run
  git backup run --quiet && echo "safe to close the laptop"`,

  sweep: `git backup sweep - run every registered repo; the launchd entrypoint

usage: git backup sweep [--dry-run]

Iterates the global maintenance.repo list and performs 'git backup run' in each
repo. Repos with no 'backup' remote, or with backup.enabled=false, are skipped
silently. This is the command the launchd agent invokes.

The dirty check happens before the reachability probe, so the common case - a
clean repo - never touches the network. That keeps a five-minute interval cheap
even with a hundred registered repos and the backup volume unmounted.

A failure in one repo does not stop the sweep; failures are reported at the end.
If nothing anywhere needed backing up, sweep exits 2.

flags
  --dry-run   Report what each repo would do without writing refs or pushing.

exit codes
  0 at least one repo was backed up   1 at least one repo failed
  2 nothing to do anywhere

examples
  git backup sweep
  git backup sweep --dry-run --verbose
  git backup agent log               # what the scheduled sweeps have been doing`,

  prune: `git backup prune - retire remote branches that no longer exist locally

usage: git backup prune [--yes] [--dry-run]

Finds branches on the destination that have no counterpart under local
refs/heads/*, copies each tip to refs/backup/attic/<branch>/<shortsha>, and then
deletes the branch from the destination. Nothing is destroyed: the commits stay
reachable through the attic ref until 'git backup gc' expires it, and
backup.atticExpire (default 90d) controls when that is.

Setting backup.attic=false skips the attic copy and deletes outright. That is
the only way to lose data here, and it is off by default.

flags
  --yes       Do not prompt. Required when running non-interactively.
  --dry-run   List the branches that would be retired and the attic refs that
              would be created, then exit.

examples
  git backup prune --dry-run
  git backup prune --yes
  git for-each-ref refs/backup/attic  # what has been retired so far`,

  restore: `git backup restore - inspect or restore a snapshot bucket

usage: git backup restore <bucket> [--all] [--yes] [-- <path>...]

<bucket> is one of the names in backup.buckets: latest, hourly, daily, weekly.
It resolves to refs/backup/snap/<host>/<worktree>/<bucket>, where <worktree> is
'_main' in the repo's main worktree and git's worktree id in a linked one.

With no paths and no --all, restore prints the diff between your worktree and
that bucket and changes nothing. That is the default because it is the operation
you almost always want first: see what the snapshot holds before taking it.

With paths after '--', those paths are restored from the bucket into the
worktree. With --all, every path present in the snapshot is restored. Both
overwrite uncommitted work in the paths they touch, so both prompt unless --yes.

--all is deliberately non-destructive: it runs 'git restore --source=<ref> -- .',
which rewrites the paths the snapshot contains but does NOT delete files you
created after it was taken. Restoring never removes anything from your worktree.

flags
  --all       Restore every path in the snapshot, not just the named ones. Files
              created since the snapshot are left alone, not deleted.
  --yes       Do not prompt before overwriting worktree files.
  -- <path>   Restore only these paths. Everything after '--' is a path.

examples
  git backup restore hourly                      # just show me the diff
  git backup restore hourly -- src/foo.ts        # take one file back
  git backup restore daily --all --yes           # take yesterday's tree back

  # The raw git equivalents, if you would rather drive it yourself:
  git diff refs/backup/snap/$(hostname -s)/_main/daily
  git restore --source=refs/backup/snap/$(hostname -s)/_main/hourly -- src/foo.ts`,

  gc: `git backup gc - expire attic refs that are past backup.atticExpire

usage: git backup gc [--yes]

Deletes refs under refs/backup/attic/ whose tip is older than backup.atticExpire
(default 90d), locally and on the destination. Attic refs are the tips that
'git backup prune' preserved when it retired a remote branch; expiring one makes
those commits unreachable and eligible for ordinary garbage collection.

Snapshot buckets are not touched: they are rotated by 'snap', not expired here.

flags
  --yes   Do not prompt. Required when running non-interactively.

examples
  git backup gc                                  # prompts, listing what it drops
  git backup gc --yes
  git config --global backup.atticExpire 30d     # keep retired tips for a month`,

  status: `git backup status - diagnostics for the current repo

usage: git backup status

Reports, for the repo containing the current directory: the resolved destination
and whether it is reachable, whether the repo is in the maintenance registry,
whether backup.enabled is set, which hooks are installed, the age and tree of
each snapshot bucket, how many local commits have not reached the destination,
and which config keys are set locally versus globally.

Start here when a repo is not being backed up and you do not know why.

flags
  (none beyond the global flags)

examples
  git backup status
  git backup status --verbose        # also echo the git commands used to probe
  git backup agent status            # the other half: is the sweeper running?`,

  agent: `git backup agent - manage the launchd agent that runs sweeps

usage: git backup agent install [--reconfigure]
       git backup agent uninstall
       git backup agent status
       git backup agent kick
       git backup agent log

subcommands
  install     Write ~/Library/LaunchAgents/<label>.plist and load it.

              When backup.root is not set, install first runs a short setup
              wizard. It asks for the destination root (offering
              /Volumes/Backup/Dev and ssh://nas.local/srv/backup as examples),
              the local base directory (default $HOME/Dev) and the sweep
              interval in seconds (default 300). It then prints the exact
              'git config --global' lines it will write and asks you to
              confirm. Decline and it writes nothing, printing the commands so
              you can run them yourself. Pass --reconfigure to run the wizard
              again even when backup.root is already set.

              If the destination is a local path that does not exist yet, the
              wizard says it will be created on first use. If neither it nor its
              parent is writable, it warns you - usually this means a removable
              or network volume is not mounted - and asks for explicit
              confirmation before saving.

              The label is backup.agentLabel (default dev.gitbackup.sweep),
              overridable with GIT_BACKUP_LABEL. The job runs 'git-backup sweep'
              with StartInterval backup.interval (default 300), StartOnMount
              true, ThrottleInterval 60, ProcessType Background, LowPriorityIO
              true and RunAtLoad false. Output goes to
              ~/Library/Logs/git-backup.log. StartOnMount is what makes plugging
              the backup drive in trigger a sweep. Re-running install rewrites
              and reloads the plist.
  uninstall   Unload the job and remove the plist. Registered repos, remotes and
              every ref already pushed are untouched; only the schedule stops.
  status      Whether the plist exists, whether launchd has it loaded, its last
              exit status and the last few log lines.
  kick        Run the job now via 'launchctl kickstart gui/<uid>/<label>'. This
              is exactly what the installed git hooks call, which is why a
              commit produces a backup within seconds instead of on the next
              interval. Never prompts, and exits 0 even with no agent installed,
              so a hook can never block your commit.
  log         Tail ~/Library/Logs/git-backup.log.

  Only 'install' and 'init' ever prompt, and only when both stdin and stdout are
  a terminal. 'sweep' and 'agent kick' contain no reachable prompt at all, which
  is the real guarantee: with fd 0 closed outright, process.stdin.isTTY reports
  true and a prompt would block forever, so confining prompts to specific
  commands protects you where a TTY check alone would not.

  If you install git-backup through the home-manager module, home-manager owns
  the agent and its label is org.nix-community.home.git-backup. Do not also run
  'agent install'; instead point the hooks at the right job with
  'git config --global backup.agentLabel org.nix-community.home.git-backup'.

examples
  git backup agent install                  # asks the setup questions if needed
  git backup agent install --reconfigure    # change the answers later
  git backup agent install --no-interactive # fail instead of asking
  git backup agent status
  git backup agent kick
  git backup agent log
  git config --global backup.interval 900 && git backup agent install`,

  hooks: `git backup hooks - install or remove this repo's hooks

usage: git backup hooks install
       git backup hooks uninstall

subcommands
  install     Add a 'git backup agent kick' call to post-commit, post-rewrite,
              post-checkout and post-merge in the current repo. The hooks make a
              commit or a rebase produce a backup within seconds instead of on
              the agent's next interval. 'git backup init' does this for you
              unless you pass --no-hooks.
  uninstall   Remove those calls again.

Hooks are written as a fenced, chainable block marked with a sentinel comment,
appended to any existing hook rather than replacing it, and made executable.
Re-running install is idempotent: the block is replaced, not duplicated. Other
tools that follow the same convention - git-auto-remote does - coexist in the
same hook file untouched, and uninstall removes only git-backup's block.

The hook body never blocks your commit: kicking the agent is a fire-and-forget
launchctl call, and it exits 0 even when no agent is installed.

examples
  git backup hooks install
  git backup hooks uninstall
  cat .git/hooks/post-commit         # see the chained blocks`,

  help: `git backup help - show help for git-backup or one of its commands

usage: git backup help [<command>]
       git backup <command> --help
       git backup --help

With no argument, prints the overview: the command list, a quick start, how the
repo registry works, the full configuration table and the exit codes. With a
command name, prints that command's page.

examples
  git backup help
  git backup help restore
  git backup help agent
  git backup --version`,
};

/** Every command name, in the order they are presented in the overview. */
export const COMMANDS: readonly string[] = Object.keys(PAGES);

/** The page for one command, or null when the name is not a command. */
export function commandHelp(cmd: string): string | null {
  return Object.prototype.hasOwnProperty.call(PAGES, cmd) ? PAGES[cmd]! : null;
}
