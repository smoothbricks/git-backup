import { access, constants } from "node:fs/promises";
import { dirname } from "node:path";
import { setGlobalConfig, type Git } from "./git.ts";
import { loadConfig } from "./config.ts";
import { parseRoot } from "./repo.ts";

/**
 * Whether it is safe to block on input.
 *
 * Both directions must be a terminal. This is necessary but NOT sufficient:
 * with fd 0 closed outright, isTTY reports true and prompt() blocks forever.
 * The real protection is structural - `sweep` and `agent kick` never reach any
 * prompt, so a launchd run or a git hook cannot hang. Treat this as the second
 * line of defence, for someone piping an otherwise interactive command.
 */
export function canPrompt(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && !noInteractive;
}

let noInteractive = false;
export function setNoInteractive(v: boolean): void {
  noInteractive = v;
}

/** Bun's confirm() misreads piped input, so every question goes through prompt(). */
function ask(question: string, fallback: string): string {
  const answer = prompt(`  ${question}`);
  if (answer === null) return fallback;
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function askYesNo(question: string, def: boolean): boolean {
  const answer = ask(`${question} [${def ? "Y/n" : "y/N"}]:`, def ? "y" : "n");
  return /^y(es)?$/i.test(answer);
}

export type SetupResult = { root: string; base: string; interval: number } | null;

/**
 * First-run wizard for the global settings.
 *
 * Returns null when the user declined or input is unavailable, and the caller
 * then reports the manual commands instead. Never throws on a refusal.
 */
export async function setupWizard(git: Git, opts: { reconfigure?: boolean } = {}): Promise<SetupResult> {
  const cfg = await loadConfig(git);
  if (cfg.root && !opts.reconfigure) return { root: cfg.root, base: cfg.base, interval: cfg.interval };

  if (!canPrompt()) return null;

  console.log("");
  console.log("git-backup setup");
  console.log("");
  console.log("  Where should backups go? Any transport git can push to:");
  console.log("    /Volumes/Backup/Dev            a mounted disk or network share");
  console.log("    ssh://nas.local/srv/backup     a machine you can ssh to");
  console.log("");

  const root = ask(`destination root${cfg.root ? ` [${cfg.root}]` : ""}:`, cfg.root ?? "");
  if (root.length === 0) {
    console.log("");
    console.log("  No destination given; nothing configured.");
    return null;
  }

  const dest = parseRoot(root);
  if (dest.kind === "local") {
    try {
      await access(dest.path, constants.W_OK);
    } catch {
      const parent = dirname(dest.path);
      let parentOk = true;
      try {
        await access(parent, constants.W_OK);
      } catch {
        parentOk = false;
      }
      console.log("");
      console.log(
        parentOk
          ? `  Note: ${dest.path} does not exist yet; it will be created on first use.`
          : `  Warning: ${dest.path} is not writable and neither is ${parent}.`,
      );
      if (!parentOk) {
        console.log("  If that is a removable or network volume, mount it and re-run.");
        if (!askYesNo("Save this destination anyway?", false)) return null;
      }
    }
  }

  console.log("");
  const base = ask(`local repos live under [${cfg.base}]:`, cfg.base);
  const intervalRaw = ask(`sweep interval in seconds [${cfg.interval}]:`, String(cfg.interval));
  const interval = Number(intervalRaw) || cfg.interval;

  console.log("");
  console.log("  Will write:");
  console.log(`    git config --global backup.root     ${root}`);
  console.log(`    git config --global backup.base     ${base}`);
  console.log(`    git config --global backup.interval ${interval}`);
  console.log("");
  if (!askYesNo("Proceed?", true)) return null;

  await setGlobalConfig("backup.root", root);
  await setGlobalConfig("backup.base", base);
  await setGlobalConfig("backup.interval", String(interval));

  console.log("");
  return { root, base, interval };
}

/** The manual equivalent, for non-interactive runs and for declining the wizard. */
export function manualSetupHint(): string {
  return [
    "No destination configured.",
    "  git config --global backup.root /Volumes/Backup/Dev   # or ssh://host/srv/backup",
    "",
    "  Then re-run. Or pass it directly:  git backup init --root <url>",
  ].join("\n");
}
