'use strict';

/**
 * A safety net for operations that cannot be undone.
 *
 * `git bundle` writes every ref and object into one file. If a rewrite goes
 * wrong — the wrong identity, the wrong file, a mailmap typo — the bundle can
 * be cloned back into a working repo with the original history intact. It
 * costs a second and it is the difference between a mistake and a disaster,
 * so every destructive flow offers one.
 */

const { spawnSync } = require('child_process');
const path = require('path');

/**
 * @returns {{path: string}|null} where the bundle was written
 * @throws if git could not write it
 */
function createBackupBundle(repoPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${path.basename(repoPath)}-backup-${stamp}.bundle`;
  const dest = path.join(path.dirname(repoPath), name);

  const res = spawnSync('git', ['bundle', 'create', dest, '--all'], {
    cwd: repoPath,
    stdio: 'pipe',
  });

  if (res.status !== 0) {
    const err = res.stderr ? res.stderr.toString().trim() : '';
    throw new Error(err || 'git bundle failed');
  }
  return { path: dest };
}

/** The command that turns a bundle back into a repo, for the summary text. */
function restoreHint(bundlePath) {
  return `git clone "${bundlePath}" restored-repo`;
}

module.exports = { createBackupBundle, restoreHint };
