'use strict';

/**
 * Git history analysis – find every commit that ever touched a given file path.
 */

const simpleGit = require('simple-git');

/**
 * Get list of all files ever tracked by git in the repo.
 * @param {string} repoPath
 * @returns {Promise<string[]>}
 */
async function getAllTrackedFiles(repoPath) {
  const git = simpleGit(repoPath);

  // All files in working tree right now
  const lsFiles = await git.raw(['ls-files']);

  // All files that ever existed (across all commits)
  const logFiles = await git.raw([
    'log',
    '--all',
    '--pretty=format:',
    '--name-only',
    '--diff-filter=A',
  ]);

  const current  = lsFiles.split('\n').map((s) => s.trim()).filter(Boolean);
  const historic = logFiles.split('\n').map((s) => s.trim()).filter(Boolean);

  const all = Array.from(new Set([...current, ...historic]));
  return all.sort();
}

/**
 * Find all commits (hash + message + date) that contain the given file path.
 * @param {string} repoPath
 * @param {string} filePath  – repo-relative path (forward slashes)
 * @returns {Promise<Array<{hash, date, message}>>}
 */
async function findCommitsForFile(repoPath, filePath) {
  const git = simpleGit(repoPath);

  let raw;
  try {
    raw = await git.raw([
      'log',
      '--all',
      '--follow',
      '--pretty=format:%H|%ad|%s',
      '--date=short',
      '--',
      filePath,
    ]);
  } catch {
    return [];
  }

  if (!raw.trim()) return [];

  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...rest] = line.split('|');
      return { hash: hash.trim(), date: date.trim(), message: rest.join('|') };
    });
}

/**
 * Get the remote refs (branch names) so we can warn about force-push.
 * @param {string} repoPath
 * @returns {Promise<string[]>}
 */
async function getRemoteBranches(repoPath) {
  const git = simpleGit(repoPath);
  try {
    const remotes = await git.raw(['branch', '-r']);
    return remotes
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.includes('->'));
  } catch {
    return [];
  }
}

/**
 * Get closest remote URL (origin first).
 * @param {string} repoPath
 * @returns {Promise<string|null>}
 */
async function getRemoteUrl(repoPath) {
  const git = simpleGit(repoPath);
  try {
    const remotes = await git.getRemotes(true);
    const origin  = remotes.find((r) => r.name === 'origin') || remotes[0];
    return origin ? origin.refs.push || origin.refs.fetch : null;
  } catch {
    return null;
  }
}

module.exports = { getAllTrackedFiles, findCommitsForFile, getRemoteBranches, getRemoteUrl };
