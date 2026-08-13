'use strict';

/**
 * Secret REDACTION — the counterpart to scrubFile().
 *
 * scrubFile() removes an entire file from history. That is the right move for
 * a file that should never have been tracked (`.env`, `credentials.json`).
 *
 * It is the WRONG move when the leaked secret lives inside a file you need to
 * keep — a source file with a hardcoded password, say. Vanishing it would
 * delete that file from every historical commit and leave it untracked.
 *
 * This module rewrites the *content* instead: every occurrence of the secret
 * across all commits, branches and tags becomes a placeholder, while the files
 * themselves stay exactly where they are.
 *
 * Requires git-filter-repo. filter-branch cannot do this safely — it would
 * need a tree-filter that rewrites every blob on every commit, which is
 * pathologically slow and easy to get wrong.
 */

const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

function run(cmd, cwd, { silent = false, failOk = false } = {}) {
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    stdio: silent ? 'pipe' : 'inherit',
    env: { ...process.env, FILTER_BRANCH_SQUELCH_WARNING: '1' },
  });
  if (res.status !== 0 && !failOk) {
    throw new Error((res.stderr && res.stderr.toString()) || `Command failed: ${cmd}`);
  }
  return res.stdout ? res.stdout.toString().trim() : '';
}

function hasFilterRepo() {
  // shell:false — the args are passed straight to git, so nothing to escape.
  const res = spawnSync('git', ['filter-repo', '--version'], { stdio: 'pipe' });
  return res.status === 0;
}

/**
 * Commits where the number of occurrences of the secret CHANGED (`git log -S`),
 * i.e. the commits that introduced or removed it — not the number of commits
 * whose tree contains it, which is usually far larger.
 *
 * Counting the latter would mean grepping every commit's tree; this is the
 * cheap proxy. It is exact for what matters: a secret that is truly gone from
 * every commit has zero such commits, so post-rewrite verification is sound.
 */
function countOccurrences(repoPath, secret) {
  const res = spawnSync(
    'git',
    ['log', '--all', '--oneline', '-S', secret],
    { cwd: repoPath, shell: false, stdio: 'pipe' }
  );
  const out = res.stdout ? res.stdout.toString().trim() : '';
  return out ? out.split('\n').length : 0;
}

/**
 * Replace every occurrence of one or more secrets across ALL history.
 *
 * @param {string}   repoPath     absolute path to the repo root
 * @param {string[]} secrets      literal strings to redact
 * @param {object}   opts
 * @param {string}   opts.replacement  text to substitute (default "***REMOVED***")
 * @param {boolean}  opts.dryRun       report only, change nothing
 * @param {Function} onProgress
 */
async function redactSecrets(repoPath, secrets, opts = {}, onProgress = console.log) {
  const replacement = opts.replacement || '***REMOVED***';
  const dryRun = !!opts.dryRun;

  if (!hasFilterRepo()) {
    throw new Error(
      'git-filter-repo is required for secret redaction but was not found.\n' +
        '  Install it with:  brew install git-filter-repo\n' +
        '                    (or) pip install git-filter-repo'
    );
  }

  // Report scope before doing anything irreversible.
  const found = [];
  for (const secret of secrets) {
    const n = countOccurrences(repoPath, secret);
    onProgress(
      n > 0
        ? chalk.yellow(`  "${maskSecret(secret)}" → present in history (touched by ${n} commit(s))`)
        : chalk.gray(`  "${maskSecret(secret)}" → not present in history`)
    );
    if (n > 0) found.push(secret);
  }

  if (found.length === 0) {
    onProgress(chalk.green('  Nothing to redact — history is already clean.'));
    return { changed: false, method: 'filter-repo' };
  }

  if (dryRun) {
    onProgress(chalk.cyan('  --dry-run: stopping before any changes.'));
    return { changed: false, dryRun: true, method: 'filter-repo' };
  }

  // filter-repo takes replacements as a file: one `literal==>replacement` per line.
  const listPath = path.join(os.tmpdir(), `git-vanish-replacements-${Date.now()}.txt`);
  fs.writeFileSync(listPath, found.map((s) => `${s}==>${replacement}`).join('\n') + '\n', 'utf8');

  try {
    onProgress('Rewriting history with git filter-repo --replace-text…');
    // --force: the repo is not a fresh clone (filter-repo's default safety check).
    run(`git filter-repo --force --replace-text "${listPath}"`, repoPath);
    onProgress('Rewrite complete.');
  } finally {
    try { fs.unlinkSync(listPath); } catch {}
  }

  // filter-repo already expires reflogs and gcs, but old refs can linger when
  // the repo had a remote configured.
  onProgress('Expiring reflogs and collecting garbage…');
  run('git reflog expire --expire=now --all', repoPath, { failOk: true, silent: true });
  run('git gc --prune=now --aggressive', repoPath, { failOk: true, silent: true });

  // Verify — the whole point is that the secret is actually gone.
  const remaining = [];
  for (const secret of found) {
    if (countOccurrences(repoPath, secret) > 0) remaining.push(secret);
  }
  if (remaining.length > 0) {
    throw new Error(
      `Redaction incomplete — still present in history: ${remaining.map(maskSecret).join(', ')}`
    );
  }
  onProgress(chalk.green('  ✔  Verified: no occurrences remain in any commit.'));

  return { changed: true, redacted: found.length, method: 'filter-repo' };
}

/** Never print a full secret back to the terminal or logs. */
function maskSecret(s) {
  if (s.length <= 8) return s[0] + '***';
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

module.exports = { redactSecrets, countOccurrences, maskSecret };
