'use strict';

/**
 * Core git history rewriting.
 *
 * Strategy
 * ────────
 * 1. Run  git filter-branch --force --index-filter "git rm --cached --ignore-unmatch <file>"
 *         --prune-empty --tag-name-filter cat -- --all
 *    This is universally available (built into git). It rewrites every branch/tag.
 *
 * 2. Expire reflogs and GC aggressively so the file is truly gone locally.
 *
 * 3. Print the correct force-push commands so users can clean the remote too.
 *
 * Note: git-filter-repo (Python) is faster but not bundled with git. We fall
 *       back to it if present because it also automatically handles the gc/reflog
 *       steps. We try filter-repo first, then filter-branch.
 */

const { execSync, spawnSync } = require('child_process');
const path  = require('path');
const chalk = require('chalk');

/* ─── helpers ──────────────────────────────────────────────── */

function run(cmd, cwd, { silent = false, failOk = false } = {}) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: silent ? 'pipe' : 'inherit',
    env: {
      ...process.env,
      // Silence git filter-branch warnings about being slow
      FILTER_BRANCH_SQUELCH_WARNING: '1',
    },
  });

  if (res.status !== 0 && !failOk) {
    const err = res.stderr ? res.stderr.toString() : '';
    throw new Error(err || `Command failed: ${cmd}`);
  }
  return res.stdout ? res.stdout.toString().trim() : '';
}

/** Check if a command exists in PATH */
function cmdExists(name) {
  try {
    const r = spawnSync(name, ['--version'], { shell: true, stdio: 'pipe' });
    return r.status === 0;
  } catch {
    return false;
  }
}

/* ─── approach 1 – git filter-repo (preferred) ────────────── */

async function rewriteWithFilterRepo(repoPath, filePath, onProgress) {
  onProgress('Using git filter-repo (fast path)…');

  // Normalize path separators for git
  const gitPath = filePath.replace(/\\/g, '/');

  run(`git filter-repo --force --path "${gitPath}" --invert-paths`, repoPath);
  onProgress('git filter-repo complete.');
}

/* ─── approach 2 – git filter-branch (universal) ──────────── */

async function rewriteWithFilterBranch(repoPath, filePath, onProgress) {
  onProgress('Using git filter-branch (universal path)…');
  onProgress(chalk.gray('  This may take a while on repos with many commits.\n'));

  const gitPath = filePath.replace(/\\/g, '/');

  // On Windows the index-filter command runs inside Git's sh.exe, so use
  // the POSIX command with forward slashes.
  // Use -r so that directories (e.g. node_modules/) are removed recursively.
  const indexFilter = `git rm -r --cached --ignore-unmatch "${gitPath}"`;

  run(
    `git filter-branch --force --index-filter "${indexFilter}" --prune-empty --tag-name-filter cat -- --all`,
    repoPath
  );

  onProgress('filter-branch complete. Cleaning up backups and reflogs…');
}

/* ─── cleanup (remove local traces) ───────────────────────── */

async function cleanup(repoPath, onProgress) {
  onProgress('Removing filter-branch backup refs…');
  run('git for-each-ref --format="%(refname)" refs/original/ | xargs -r git update-ref -d', repoPath, { failOk: true, silent: true });
  // Windows-compatible alternative
  run('git update-ref -d refs/original/refs/heads/main 2>NUL || exit 0', repoPath, { failOk: true, silent: true });

  onProgress('Expiring reflogs…');
  run('git reflog expire --expire=now --all', repoPath, { failOk: true });

  onProgress('Running aggressive garbage collection (this may take a minute)…');
  run('git gc --prune=now --aggressive', repoPath, { failOk: true });
}

/* ─── add to .gitignore ────────────────────────────────────── */

const fs = require('fs');

function addToGitignore(repoPath, filePath) {
  const ignorePath = path.join(repoPath, '.gitignore');
  const gitPath    = filePath.replace(/\\/g, '/');

  let existing = '';
  if (fs.existsSync(ignorePath)) {
    existing = fs.readFileSync(ignorePath, 'utf8');
    // Check if already present (with or without leading slash, with or without trailing slash)
    const lines   = existing.split('\n').map((l) => l.trim());
    const base    = gitPath.replace(/\/$/, '');        // strip trailing slash
    const checked = [base, base + '/', '/' + base, '/' + base + '/'];
    if (checked.some((v) => lines.includes(v))) {
      return false; // already ignored
    }
  }

  const newEntry = `\n# Added by git-scrub — sensitive file removed from history\n${gitPath}\n`;
  fs.writeFileSync(ignorePath, existing + newEntry, 'utf8');
  return true;
}

/* ─── working tree backup / restore ───────────────────────── */

/**
 * Preserve the current working-tree copy of the target BEFORE git rewrites
 * history (which will delete the file/directory from the working tree as it
 * checks out the new HEAD that no longer contains the path).
 *
 * Strategy:
 *  • Directory → rename to <path>.git-scrub-bak  (instant, zero extra disk)
 *  • File      → rename to <path>.git-scrub-bak
 *
 * Returns the backup path, or null if nothing existed on disk.
 */
function backupWorkingTree(fullPath, onProgress) {
  if (!fs.existsSync(fullPath)) return null;

  const backupPath = fullPath.replace(/\\/g, '/').replace(/\/$/, '') + '.git-scrub-bak';

  // Remove stale backup if one exists from a previous failed run
  if (fs.existsSync(backupPath)) {
    try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch {}
  }

  fs.renameSync(fullPath, backupPath);
  onProgress(chalk.gray(`  Working-tree copy saved → ${path.basename(backupPath)}`));
  return backupPath;
}

/**
 * After history rewrite, move the backup back to the original path.
 * The file becomes untracked (because .gitignore now lists it).
 */
function restoreWorkingTree(backupPath, fullPath, onProgress) {
  if (!fs.existsSync(backupPath)) return;

  // If git somehow put an empty placeholder there, remove it first
  if (fs.existsSync(fullPath)) {
    try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch {}
  }

  // Ensure parent directory exists
  const parent = path.dirname(fullPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });

  fs.renameSync(backupPath, fullPath);
  onProgress(chalk.gray(`  Working-tree copy restored → ${path.basename(fullPath)}`));
}

/* ─── main export ──────────────────────────────────────────── */

/**
 * Remove a file/directory from ALL git history while preserving the current
 * working-tree copy as an untracked file.
 *
 * Flow:
 *  1. Add path to .gitignore (so after restore git won't re-track it)
 *  2. Rename file/dir to a temp backup name (instant — no copying)
 *  3. Rewrite history (filter-repo or filter-branch)
 *  4. Clean up reflogs + run gc
 *  5. Rename backup back to original — file is now untracked, data preserved
 *
 * @param {string}   repoPath   – absolute path to git repo root
 * @param {string}   filePath   – repo-relative path (e.g. "config/secrets.json")
 * @param {Function} onProgress – callback(message) for progress updates
 */
async function scrubFile(repoPath, filePath, onProgress = console.log) {
  const fullPath = path.join(repoPath, filePath.replace(/\//g, path.sep));

  // ── 1. Add to .gitignore first so restoring won't re-track the file ──
  const added = addToGitignore(repoPath, filePath);

  // ── 2. Backup working tree (rename away so filter-branch doesn't see it) ──
  const backupPath = backupWorkingTree(fullPath, onProgress);

  // ── 3. Rewrite history ──────────────────────────────────────────────────
  const hasFilterRepo = cmdExists('git-filter-repo');
  try {
    if (hasFilterRepo) {
      await rewriteWithFilterRepo(repoPath, filePath, onProgress);
    } else {
      await rewriteWithFilterBranch(repoPath, filePath, onProgress);
    }
  } catch (err) {
    // Rewrite failed — restore the backup so no data is lost
    if (backupPath) {
      onProgress(chalk.yellow('  Rewrite failed — restoring working-tree copy…'));
      restoreWorkingTree(backupPath, fullPath, onProgress);
    }
    throw err;
  }

  // ── 4. Cleanup ─────────────────────────────────────────────────────────
  await cleanup(repoPath, onProgress);

  // ── 5. Restore working tree — file is now untracked + gitignored ───────
  if (backupPath) {
    restoreWorkingTree(backupPath, fullPath, onProgress);
    onProgress(chalk.green(`  ✔  "${filePath}" is now untracked (data preserved on disk).`));
  }

  return {
    method:         hasFilterRepo ? 'filter-repo' : 'filter-branch',
    gitignoreAdded: added,
  };
}

module.exports = { scrubFile };
