'use strict';

/**
 * One place to invoke git-filter-repo from.
 *
 * All three operations — vanishing a file, redacting a string, reassigning an
 * identity — drive the same tool, and they were each getting the invocation
 * subtly wrong in their own way. Two problems in particular:
 *
 *  1. **The re-run prompt.** After any successful run, filter-repo leaves a
 *     marker at `.git/filter-repo/already_ran`. When that marker is more than a
 *     day old, the next run stops and asks, on stdin:
 *
 *         Treat this run as a continuation of filtering in the previous run (Y/N)?
 *
 *     `--force` does not suppress it — that flag is consulted later, for the
 *     fresh-clone check. We capture the child's output, so its stdin is a
 *     closed pipe, and Python's `input()` raises EOFError and dies with a
 *     traceback. The effect is that git-vanish worked once on a repository and
 *     then refused to work on it again, a day later, with an error nobody could
 *     act on. `prepareRerun()` settles the question before we ever invoke the
 *     tool, so the prompt cannot be reached.
 *
 *  2. **Shell quoting.** Arguments were interpolated into a shell string, so a
 *     repository or temp path containing a quote or a space was a latent bug.
 *     Here the argv is passed straight to git.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Is git-filter-repo installed and runnable? */
function hasFilterRepo() {
  return spawnSync('git', ['filter-repo', '--version'], { stdio: 'pipe' }).status === 0;
}

/** `.git` for a normal checkout; the directory itself for a bare repo. */
function gitDir(repoPath) {
  const res = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: repoPath, stdio: 'pipe',
  });
  if (res.status === 0) return res.stdout.toString().trim();
  return path.join(repoPath, '.git');
}

/**
 * Decide, ahead of time, how filter-repo should treat a repository it has
 * already filtered — so that it never has to ask.
 *
 * Answering the prompt with Y and with N differ only in bookkeeping; the
 * rewrite itself is identical either way. Y chains this run's `commit-map`,
 * `ref-map` and `first-changed-commits` onto the previous run's, so they keep
 * mapping back to the SHAs the repository had before *any* filtering. N throws
 * that history away and starts the map afresh.
 *
 * Y is therefore the better answer, and we get it by making the marker look
 * recent rather than by piping a keystroke — filter-repo only prompts when the
 * marker is over a day old. But the chained path reads those metadata files
 * directly, so it is only safe when they are all present; when they are not
 * (an interrupted run, an older filter-repo, a hand-cleaned .git), we drop the
 * marker instead and take the fresh path.
 *
 * @returns {{rerun: boolean, mode: 'continuation'|'fresh'|null}}
 */
function prepareRerun(repoPath) {
  const marker = path.join(gitDir(repoPath), 'filter-repo', 'already_ran');
  if (!fs.existsSync(marker)) return { rerun: false, mode: null };

  const dir = path.dirname(marker);
  const chainable = ['commit-map', 'first-changed-commits']
    .every((f) => fs.existsSync(path.join(dir, f)));

  if (chainable) {
    // Reset the mtime: under a day old means no prompt, and `_already_ran`
    // stays true, which is the continuation behaviour we want.
    const now = new Date();
    try {
      fs.utimesSync(marker, now, now);
      return { rerun: true, mode: 'continuation' };
    } catch { /* fall through to the fresh path */ }
  }

  try { fs.unlinkSync(marker); } catch { /* filter-repo will prompt; nothing more we can do */ }
  return { rerun: true, mode: 'fresh' };
}

/**
 * Turn a filter-repo failure into something a human can act on.
 * Its fatal errors arrive as a Python traceback, which tells the user what
 * broke inside filter-repo but not what to do about it.
 */
function explainFailure(output) {
  const text = String(output || '');

  if (/EOFError|Treat this run as a continuation/.test(text)) {
    return 'git-filter-repo stopped to ask a question it could not be given an answer to.\n' +
      '  This repository has been filtered before (.git/filter-repo/already_ran).\n' +
      '  Remove that file and run git-vanish again.';
  }
  if (/not a fresh clone/i.test(text)) {
    return 'git-filter-repo wants a fresh clone of this repository.\n' +
      '  Clone it again and rewrite the clone, or re-run with the working tree clean.';
  }
  if (/Cannot rewrite history with uncommitted changes|is not clean/i.test(text)) {
    return 'The working tree has changes. Commit or stash them, then run git-vanish again.';
  }
  if (/could not be found|command not found|is not a git command/i.test(text)) {
    return 'git-filter-repo is not installed.\n' +
      '  Install it with:  brew install git-filter-repo   (or)  pip install git-filter-repo';
  }

  // Nothing recognised — hand back filter-repo's own last words, which are
  // more useful than any summary we could invent.
  const lines = text.trim().split('\n').filter((l) => l.trim());
  const meaningful = lines.filter((l) => !/^\s*(File "|  |Traceback)/.test(l));
  return (meaningful.length ? meaningful : lines).slice(-6).join('\n');
}

/**
 * Run git-filter-repo. Always add `--force` yourself if you want it; nothing
 * is added here beyond the re-run handling.
 *
 * @param {string}   repoPath
 * @param {string[]} argv      arguments after `filter-repo`
 * @returns {{stdout: string, rerun: object}}
 * @throws {Error} with a human-readable message on failure
 */
function runFilterRepo(repoPath, argv, { onProgress } = {}) {
  const rerun = prepareRerun(repoPath);
  if (rerun.mode === 'continuation' && onProgress) {
    onProgress('This repository has been filtered before — continuing that history.');
  } else if (rerun.mode === 'fresh' && onProgress) {
    onProgress('This repository has been filtered before — starting a new rewrite map.');
  }

  const res = spawnSync('git', ['filter-repo', ...argv], {
    cwd: repoPath,
    stdio: 'pipe',
    // An empty stdin rather than an inherited one: if a future version of
    // filter-repo asks something we have not anticipated, it fails at once
    // instead of hanging forever on a terminal nobody is watching.
    input: '',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
  });

  if (res.error) throw new Error(`Could not run git-filter-repo: ${res.error.message}`);

  if (res.status !== 0) {
    const output = [res.stdout, res.stderr]
      .map((b) => (b ? b.toString() : ''))
      .filter(Boolean)
      .join('\n');
    throw new Error(explainFailure(output));
  }

  return { stdout: res.stdout ? res.stdout.toString() : '', rerun };
}

module.exports = { hasFilterRepo, runFilterRepo, prepareRerun, explainFailure, gitDir };
