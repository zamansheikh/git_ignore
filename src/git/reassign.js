'use strict';

/**
 * Reassign commit authorship across all history.
 *
 * The third thing people need from history rewriting, after removing a file
 * and redacting a string: a contributor leaves and their identity has to come
 * off the commits — a personal email that should never have been public, an
 * account being closed, contributions consolidated onto one identity.
 *
 * Every commit, file and message is preserved exactly. Only the author and
 * committer identity changes, so `git log --stat` reads the same afterwards.
 *
 * Implemented with `git filter-repo --mailmap`, which is the supported path
 * for this: it rewrites both the author and committer fields, and matches on
 * email so a person who committed under several display names is caught by one
 * rule.
 *
 * ── Worth knowing before you run it ──────────────────────────────────────
 * This removes attribution. If the person holds copyright in the code, their
 * licence terms still apply regardless of what the commit metadata says —
 * rewriting the name does not transfer authorship in any legal sense.
 * It also only affects THIS copy: existing clones, forks and anything the
 * host has already cached keep the original identity until they re-clone.
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
  return res.stdout ? res.stdout.toString() : '';
}

function hasFilterRepo() {
  return spawnSync('git', ['filter-repo', '--version'], { stdio: 'pipe' }).status === 0;
}

/**
 * Everyone who has ever authored a commit, with how many they have.
 *
 * Reads authors AND committers: a rebase or a squashed merge leaves someone as
 * committer on commits they did not author, and a reassignment that misses
 * those leaves the identity behind in half the history.
 */
function listAuthors(repoPath) {
  const out = spawnSync(
    'git',
    ['log', '--all', '--pretty=%an|%ae%n%cn|%ce'],
    { cwd: repoPath, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.status !== 0) {
    throw new Error('Could not read git history — is this a git repository?');
  }

  const counts = new Map();
  for (const line of out.stdout.toString().split('\n')) {
    const raw = line.trim();
    if (!raw || !raw.includes('|')) continue;
    const idx = raw.lastIndexOf('|');
    const name = raw.slice(0, idx).trim();
    const email = raw.slice(idx + 1).trim();
    if (!email) continue;
    const key = `${name} <${email}>`;
    const entry = counts.get(key) || { name, email, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }

  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** How many commits still carry this email, as author or committer. */
function countFor(repoPath, email) {
  const out = spawnSync(
    'git',
    ['log', '--all', '--pretty=%ae%n%ce'],
    { cwd: repoPath, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 },
  );
  const lower = email.toLowerCase();
  return out.stdout
    .toString()
    .split('\n')
    .filter((l) => l.trim().toLowerCase() === lower).length;
}

/** `Name <email>` -> {name, email}. The name is optional. */
function parseIdentity(text) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(text || '');
  if (!m) return null;
  return { name: m[1] || '', email: m[2].trim() };
}

/**
 * @param {string} repoPath
 * @param {Array<{from: string, to: string}>} pairs  each side as `Name <email>`
 * @param {{dryRun?: boolean}} opts
 */
async function reassignAuthors(repoPath, pairs, opts = {}, onProgress = console.log) {
  if (!hasFilterRepo()) {
    throw new Error(
      'git-filter-repo is required for author reassignment but was not found.\n' +
        '  Install it with:  brew install git-filter-repo\n' +
        '                    (or) pip install git-filter-repo',
    );
  }

  const mappings = [];
  for (const pair of pairs) {
    const from = parseIdentity(pair.from);
    const to = parseIdentity(pair.to);
    if (!from) throw new Error(`Could not parse identity "${pair.from}" — expected: Name <email>`);
    if (!to) throw new Error(`Could not parse identity "${pair.to}" — expected: Name <email>`);
    if (!to.name) throw new Error(`The new identity needs a name: "${pair.to}"`);
    mappings.push({ from, to });
  }

  // Report scope before doing anything irreversible.
  const found = [];
  for (const m of mappings) {
    const n = countFor(repoPath, m.from.email);
    onProgress(
      n > 0
        ? chalk.yellow(`  ${m.from.email} → ${m.to.name} <${m.to.email}>  (${n} commit refs)`)
        : chalk.gray(`  ${m.from.email} → not present in history, skipping`),
    );
    if (n > 0) found.push(m);
  }

  if (found.length === 0) {
    onProgress(chalk.green('  Nothing to reassign — none of those identities appear in history.'));
    return { changed: false };
  }

  if (opts.dryRun) {
    onProgress(chalk.cyan('  --dry-run: stopping before any changes.'));
    return { changed: false, dryRun: true };
  }

  const before = run('git rev-list --all --count', repoPath, { silent: true }).trim();

  // mailmap format: `New Name <new@email> <old@email>`
  const mailmapPath = path.join(os.tmpdir(), `git-vanish-mailmap-${Date.now()}.txt`);
  fs.writeFileSync(
    mailmapPath,
    found.map((m) => `${m.to.name} <${m.to.email}> <${m.from.email}>`).join('\n') + '\n',
    'utf8',
  );

  try {
    onProgress('Rewriting history with git filter-repo --mailmap…');
    run(`git filter-repo --force --mailmap "${mailmapPath}"`, repoPath);
    onProgress('Rewrite complete.');
  } finally {
    try { fs.unlinkSync(mailmapPath); } catch {}
  }

  // Nothing but identity should have moved. A changed commit count means
  // something else happened and the user needs to know before they force-push.
  const after = run('git rev-list --all --count', repoPath, { silent: true }).trim();
  if (before !== after) {
    throw new Error(
      `Commit count changed (${before} -> ${after}). Reassignment should preserve every ` +
        'commit — do not push this. Restore from your backup.',
    );
  }

  const remaining = [];
  for (const m of found) {
    const n = countFor(repoPath, m.from.email);
    if (n > 0) remaining.push(`${m.from.email} (${n} left)`);
  }
  if (remaining.length > 0) {
    throw new Error(`Reassignment incomplete — still present: ${remaining.join(', ')}`);
  }

  onProgress(chalk.green(`  ✔  Verified: all ${before} commits kept, old identities gone.`));
  return { changed: true, reassigned: found.length, commits: Number(before) };
}

module.exports = { reassignAuthors, listAuthors, parseIdentity, countFor };
