'use strict';

/**
 * git-scrub – main orchestrator
 *
 * Flow:
 *  1. Locate git repo root (from cwd or --repo flag)
 *  2. Fetch all git-tracked files for the file browser
 *  3. Open interactive TUI browser  →  user selects a file
 *  4. Show which commits contain the file
 *  5. Prompt for final confirmation  →  run scrub
 *  6. Print force-push instructions
 */

const path     = require('path');
const fs       = require('fs');
const chalk    = require('chalk');
const { program } = require('commander');
const simpleGit   = require('simple-git');

const FileBrowser = require('./ui/browser');
const { confirm, warnBox, successBox } = require('./ui/confirm');
const { getAllTrackedFiles, findCommitsForFile, getRemoteBranches, getRemoteUrl } = require('./git/history');
const { scrubFile } = require('./git/rewrite');

/* ─── CLI setup ──────────────────────────────────────────── */

program
  .name('git-scrub')
  .version('1.0.0')
  .description(
    'Interactively browse your repo and permanently erase a sensitive\n' +
    'file from all git commit history — without losing other commits.'
  )
  .option('-r, --repo <path>',  'Path to the git repository (default: cwd)')
  .option('-f, --file <path>',  'Repo-relative file path to scrub (skip the browser)')
  .option('--no-gc',             'Skip the garbage collection step (faster, less thorough)')
  .option('--dry-run',           'Show what would happen without changing anything')
  .parse(process.argv);

const opts = program.opts();

/* ─── helpers ────────────────────────────────────────────── */

async function findRepoRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function printBanner() {
  const W = process.stdout.columns || 80;
  console.log(chalk.bold.red('\n' + '═'.repeat(W)));
  console.log(chalk.bold.red('  🔥 git-scrub') + chalk.bold.white(' — Scrub sensitive files from git history'));
  console.log(chalk.bold.red('═'.repeat(W)) + '\n');
}

function printCommitList(commits, filePath) {
  console.log(chalk.bold.yellow(`\n Found ${commits.length} commit(s) that contain "${filePath}":\n`));
  const shown = commits.slice(0, 20);
  for (const c of shown) {
    console.log(
      chalk.gray('  ') +
      chalk.cyan(c.hash.slice(0, 8)) +
      chalk.gray('  ' + c.date + '  ') +
      chalk.white(c.message.slice(0, 60))
    );
  }
  if (commits.length > 20) {
    console.log(chalk.gray(`  … and ${commits.length - 20} more`));
  }
  console.log('');
}

function printForcePushInstructions(repoPath, remoteUrl) {
  const W = process.stdout.columns || 80;
  console.log('\n' + chalk.bold.magenta('─'.repeat(W)));
  console.log(chalk.bold.magenta('\n  📡 IMPORTANT: Force-push to update the remote\n'));
  console.log(chalk.white('  You MUST run these commands to clean the remote:\n'));
  console.log(chalk.bold.yellow('    git push origin --force --all'));
  console.log(chalk.bold.yellow('    git push origin --force --tags'));
  console.log('');

  if (remoteUrl) {
    console.log(chalk.gray(`  Remote URL: ${remoteUrl}`));
  }

  console.log(chalk.gray('\n  ⚠  All collaborators must re-clone or run:'));
  console.log(chalk.gray('       git fetch --all'));
  console.log(chalk.gray('       git reset --hard origin/<branch>'));
  console.log('');

  console.log(chalk.gray(
    '  ⚠  If this repo is on GitHub, also rotate any leaked secrets\n' +
    '     (tokens, passwords, keys) immediately — GitHub may cache content.'
  ));
  console.log('\n' + chalk.bold.magenta('─'.repeat(W)) + '\n');
}

/* ─── main ───────────────────────────────────────────────── */

async function main() {
  printBanner();

  // ── 1. Find repo root ──────────────────────────────────
  const startDir = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const repoPath = await findRepoRoot(startDir);

  if (!repoPath) {
    console.error(chalk.red(`\n ✘  No git repository found at or above: ${startDir}\n`));
    console.error(chalk.gray('    Run this command from inside a git repository, or use --repo <path>.\n'));
    process.exit(1);
  }

  console.log(chalk.gray(` ✔  Repo root: ${repoPath}\n`));

  // ── 2. Load all git-tracked files (for the TUI) ────────
  console.log(chalk.gray(' ⏳ Loading file list from git history…'));
  let allTrackedFiles;
  try {
    allTrackedFiles = await getAllTrackedFiles(repoPath);
  } catch (e) {
    allTrackedFiles = null; // still show the browser, just without filtering
  }

  // ── 3. File selection ──────────────────────────────────
  let selectedFile = opts.file || null;

  if (selectedFile) {
    // normalize slashes
    selectedFile = selectedFile.replace(/\\/g, '/');
    console.log(chalk.cyan(` ℹ  Using file from --file flag: ${selectedFile}\n`));
  } else {
    // Open the interactive TUI browser
    selectedFile = await new Promise((resolve, reject) => {
      const browser = new FileBrowser({
        root:      repoPath,
        gitFiles:  allTrackedFiles,
        title:     '  git-scrub — Select file to erase from history',
        onSelect:  (rel) => resolve(rel),
        onCancel:  () => reject(new Error('cancelled')),
      });
      browser.start();
    }).catch((err) => {
      if (err.message === 'cancelled') {
        console.log(chalk.yellow('\n  Cancelled. No changes made.\n'));
        process.exit(0);
      }
      throw err;
    });
  }

  // ── 4. Show commits that contain the file ─────────────
  console.log(chalk.gray('\n ⏳ Searching git history…\n'));
  const commits = await findCommitsForFile(repoPath, selectedFile);

  if (commits.length === 0) {
    console.log(chalk.yellow(` ⚠  "${selectedFile}" was not found in any commit.\n`));
    console.log(chalk.gray('    It may already have been removed, or the path might be wrong.\n'));
    process.exit(0);
  }

  printCommitList(commits, selectedFile);

  // ── 5. Dry-run bail-out ────────────────────────────────
  if (opts.dryRun) {
    console.log(chalk.bold.blue(' [DRY RUN] No changes were made.\n'));
    console.log(chalk.blue(` Would scrub "${selectedFile}" from ${commits.length} commit(s).\n`));
    process.exit(0);
  }

  // ── 6. Warnings and confirmation ──────────────────────
  const remoteUrl = await getRemoteUrl(repoPath);

  warnBox([
    chalk.bold.red('  WARNING: This operation rewrites git history.'),
    '',
    chalk.white(`  File to remove : `) + chalk.bold.red(selectedFile),
    chalk.white(`  Affected commits: `) + chalk.bold.yellow(String(commits.length)),
    chalk.white(`  Repository     : `) + chalk.gray(repoPath),
    '',
    chalk.yellow('  • ALL branches and tags that contain this file will be rewritten.'),
    chalk.yellow('  • You will need to force-push to update any remote (GitHub etc.).'),
    chalk.yellow('  • All collaborators must re-clone or reset their local copies.'),
    chalk.yellow('  • Consider rotating any leaked secrets immediately.'),
    '',
    chalk.bold('  This CANNOT be undone unless you have a backup.'),
  ]);

  const ok = await confirm(`Permanently scrub "${selectedFile}" from all ${commits.length} commit(s)?`);

  if (!ok) {
    console.log(chalk.yellow('\n  Aborted. No changes were made.\n'));
    process.exit(0);
  }

  // ── 7. Run the scrub ───────────────────────────────────
  const ora = require('ora');
  const spinner = ora({ text: 'Rewriting git history…', color: 'red' }).start();

  let result;
  try {
    result = await scrubFile(repoPath, selectedFile, (msg) => {
      spinner.text = chalk.gray(msg);
    });
    spinner.succeed(chalk.green('Git history rewritten successfully.'));
  } catch (err) {
    spinner.fail(chalk.red('Scrub failed.'));
    console.error('\n' + chalk.red(err.message) + '\n');
    console.error(chalk.gray(
      ' Tip: Make sure you have no uncommitted changes before running git-scrub.\n' +
      ' Run: git stash  then try again.\n'
    ));
    process.exit(1);
  }

  // ── 8. Success summary ─────────────────────────────────
  successBox([
    chalk.bold.green('  ✔  File successfully scrubbed from all git history!'),
    '',
    chalk.white(`  File removed  : `) + chalk.bold(selectedFile),
    chalk.white(`  Method used   : `) + chalk.cyan(result.method),
    chalk.white(`  .gitignore    : `) + (result.gitignoreAdded ? chalk.green('entry added') : chalk.gray('already present')),
    chalk.white(`  Working copy  : `) + chalk.green('preserved on disk (untracked)'),
    '',
    chalk.gray(`  Your file/folder is still on disk with its latest content.`),
    chalk.gray(`  Git no longer knows it exists — it is now untracked.`),
  ]);

  printForcePushInstructions(repoPath, remoteUrl);
}

main().catch((err) => {
  console.error(chalk.red('\n ✘  Unexpected error: ' + err.message + '\n'));
  process.exit(1);
});
