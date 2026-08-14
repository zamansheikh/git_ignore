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
 * for this: it rewrites author, committer AND tagger fields, and matches on
 * email, so a person who committed under several display names is caught by
 * one rule.
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
    const detail = [res.stdout, res.stderr]
      .map((b) => (b ? b.toString().trim() : ''))
      .filter(Boolean)
      .join('\n');
    throw new Error(detail || `Command failed: ${cmd}`);
  }
  return res.stdout ? res.stdout.toString() : '';
}

function hasFilterRepo() {
  return spawnSync('git', ['filter-repo', '--version'], { stdio: 'pipe' }).status === 0;
}

/**
 * Every identity in history, with how often it appears.
 *
 * Reads authors AND committers: a rebase or a squashed merge leaves someone as
 * committer on commits they did not author, and a reassignment that misses
 * those leaves the identity behind in half the history.
 *
 * Fields are separated with NUL rather than a printable character because a
 * display name is free text — "Foo | Bar" is a legal git name and would split
 * a pipe-delimited line in the wrong place.
 */
function listAuthors(repoPath) {
  const out = spawnSync(
    'git',
    ['log', '--all', '--pretty=a%x00%an%x00%ae%n c%x00%cn%x00%ce'],
    { cwd: repoPath, stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 },
  );
  if (out.status !== 0) {
    throw new Error('Could not read git history — is this a git repository?');
  }

  const people = new Map();
  for (const raw of out.stdout.toString().split('\n')) {
    const line = raw.trimStart();
    if (!line) continue;
    const parts = line.split('\x00');
    if (parts.length !== 3) continue;

    const [role, name, email] = [parts[0], parts[1], parts[2].trim()];
    if (!email) continue;

    const key = `${name}\x00${email}`;
    const entry = people.get(key) || { name, email, authored: 0, committed: 0, count: 0 };
    if (role === 'a') entry.authored += 1; else entry.committed += 1;
    entry.count += 1;
    people.set(key, entry);
  }

  return [...people.values()].sort(
    (a, b) => b.count - a.count || a.email.localeCompare(b.email),
  );
}

/** How many commit references still carry this email, as author or committer. */
function countFor(repoPath, email) {
  const lower = String(email).toLowerCase();
  return listAuthors(repoPath)
    .filter((a) => a.email.toLowerCase() === lower)
    .reduce((sum, a) => sum + a.count, 0);
}

/**
 * `Name <email>` → {name, email}.
 *
 * A bare `someone@example.com` is accepted too: it is what people copy out of
 * `git log`, and demanding angle brackets for the side of the mapping where
 * the name is ignored anyway is pure ceremony.
 */
function parseIdentity(text) {
  const s = String(text || '').trim();
  if (!s) return null;

  const bracketed = /^(.*?)\s*<([^>]+)>$/.exec(s);
  if (bracketed) {
    const email = bracketed[2].trim();
    return email ? { name: bracketed[1].trim(), email } : null;
  }
  if (/^[^\s<>@]+@[^\s<>@]+$/.test(s)) return { name: '', email: s };
  return null;
}

/**
 * Split `Old <old@mail>=New Name <new@mail>` on the separator.
 *
 * Splitting on the first `=` breaks names that legitimately contain one
 * ("Team A=B <t@x>"), so an `=` that directly follows the closing bracket of
 * an identity wins; the first `=` is only the fallback for the bare-email form.
 */
function parseMapping(raw) {
  const s = String(raw || '');
  const afterBracket = /^(.*?>)\s*=\s*(.+)$/.exec(s);
  if (afterBracket) return { from: afterBracket[1].trim(), to: afterBracket[2].trim() };

  const at = s.indexOf('=');
  if (at < 0) return null;
  const from = s.slice(0, at).trim();
  const to = s.slice(at + 1).trim();
  if (!from || !to) return null;
  return { from, to };
}

/** Turn raw mapping strings into validated {from, to} identity pairs. */
function buildMappings(pairs) {
  return pairs.map((pair) => {
    const from = parseIdentity(pair.from);
    const to = parseIdentity(pair.to);
    if (!from) throw new Error(`Could not parse identity "${pair.from}" — expected: Name <email>`);
    if (!to) throw new Error(`Could not parse identity "${pair.to}" — expected: Name <email>`);
    if (!to.name) throw new Error(`The new identity needs a display name: "${pair.to}"`);
    if (from.email.toLowerCase() === to.email.toLowerCase() && from.name === to.name) {
      throw new Error(`"${pair.from}" and "${pair.to}" are the same identity — nothing to change.`);
    }
    return { from, to };
  });
}

/** What a reassignment would touch, without touching anything. */
function previewReassign(repoPath, pairs) {
  const mappings = buildMappings(pairs);
  return mappings.map((m) => ({ ...m, refs: countFor(repoPath, m.from.email) }));
}

/** Remotes recorded before the rewrite — filter-repo drops them. */
function captureRemotes(repoPath) {
  const out = spawnSync('git', ['remote', '-v'], { cwd: repoPath, stdio: 'pipe' });
  if (out.status !== 0) return [];
  const seen = new Map();
  for (const line of out.stdout.toString().split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());
    if (m && !seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return [...seen.entries()].map(([name, url]) => ({ name, url }));
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

  const mappings = buildMappings(pairs);

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
    return { changed: false, dryRun: true, mappings: found };
  }

  const remotes = captureRemotes(repoPath);
  const before = run('git rev-list --all --count', repoPath, { silent: true }).trim();

  // mailmap format: `New Name <new@email> <old@email>` — match on old email,
  // which catches every display name the person ever committed under.
  const mailmapPath = path.join(os.tmpdir(), `git-vanish-mailmap-${Date.now()}.txt`);
  fs.writeFileSync(
    mailmapPath,
    found.map((m) => `${m.to.name} <${m.to.email}> <${m.from.email}>`).join('\n') + '\n',
    'utf8',
  );

  try {
    onProgress('Rewriting history with git filter-repo --mailmap…');
    // Captured rather than inherited: filter-repo interleaves progress counters
    // with its own notices, and the useful part is the summary we print below.
    run(`git filter-repo --force --mailmap "${mailmapPath}"`, repoPath, { silent: true });
    onProgress('Rewrite complete.');
  } finally {
    try { fs.unlinkSync(mailmapPath); } catch {}
  }

  onProgress('Expiring reflogs and collecting garbage…');
  run('git reflog expire --expire=now --all', repoPath, { failOk: true, silent: true });
  run('git gc --prune=now', repoPath, { failOk: true, silent: true });

  // Nothing but identity should have moved. A changed commit count means
  // something else happened and the user needs to know before they force-push.
  const after = run('git rev-list --all --count', repoPath, { silent: true }).trim();
  if (before !== after) {
    throw new Error(
      `Commit count changed (${before} -> ${after}). Reassignment should preserve every ` +
        'commit — do not push this. Restore from your backup.',
    );
  }

  // Verify per mapping. When the new identity keeps the old email — renaming
  // someone rather than replacing them — the email surviving is the expected
  // outcome, so what has to be checked is that no entry still carries the old
  // display name.
  const identities = listAuthors(repoPath);
  const leftovers = [];
  for (const m of found) {
    const oldEmail = m.from.email.toLowerCase();
    const keepsEmail = m.to.email.toLowerCase() === oldEmail;
    const stale = identities.filter(
      (a) => a.email.toLowerCase() === oldEmail && (!keepsEmail || a.name !== m.to.name),
    );
    for (const s of stale) leftovers.push(`${s.name} <${s.email}> (${s.count} left)`);
  }
  if (leftovers.length > 0) {
    throw new Error(`Reassignment incomplete — still present: ${leftovers.join(', ')}`);
  }

  onProgress(chalk.green(`  ✔  Verified: all ${before} commits kept, old identities gone.`));
  return {
    changed: true,
    reassigned: found.length,
    mappings: found,
    commits: Number(before),
    remotes,
  };
}

module.exports = {
  reassignAuthors,
  listAuthors,
  parseIdentity,
  parseMapping,
  buildMappings,
  previewReassign,
  captureRemotes,
  countFor,
  hasFilterRepo,
};
