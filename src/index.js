'use strict';

/**
 * git-vanish – main orchestrator
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
const { spawnSync } = require('child_process');
const { program } = require('commander');
const simpleGit   = require('simple-git');

function run(cmd, cwd) {
  spawnSync(cmd, { cwd, shell: true, stdio: 'pipe' });
}

const FileBrowser = require('./ui/browser');
const { confirm, warnBox, successBox } = require('./ui/confirm');
const { getAllTrackedFiles, findCommitsForFile, getRemoteBranches, getRemoteUrl } = require('./git/history');
const { scrubFile, addToGitignore } = require('./git/rewrite');
const { redactSecrets, maskSecret } = require('./git/redact');
const { reassignAuthors, listAuthors } = require('./git/reassign');

/* ─── CLI setup ──────────────────────────────────────────── */

program
  .name('git-vanish')
  // Read from package.json so --version can never drift from the published release.
  .version(require('../package.json').version)
  .description(
    'Interactively browse your repo and permanently vanish a sensitive\n' +
    'file from all git commit history — file preserved on disk as untracked.\n' +
    'Or use --secret to redact a leaked string from every commit while\n' +
    'keeping the file that contained it tracked.'
  )
  .option('-r, --repo <path>',  'Path to the git repository (default: cwd)')
  .option('-f, --file <path>',  'Repo-relative file path to scrub (skip the browser)')
  .option('--no-gc',             'Skip the garbage collection step (faster, less thorough)')
  .option('--dry-run',           'Show what would happen without changing anything')
  // Redaction mode — for a secret embedded in a file you need to KEEP.
  // Removing the whole file would delete real source from every commit.
  .option(
    '-s, --secret <text>',
    'Redact this literal string from all history, keeping files tracked (repeatable)',
    (val, prev) => (prev || []).concat([val])
  )
  .option(
    '--secrets-file <path>',
    'File with one secret per line to redact (safer than --secret: keeps them out of shell history)'
  )
  .option('--replacement <text>', 'Text to substitute for redacted secrets', '***REMOVED***')
  // Author reassignment — for when a person, not a file or a string, has to
  // come out of the history.
  .option(
    '--list-authors',
    'List everyone who appears in history, with commit counts, then exit'
  )
  .option(
    '--reassign <mapping>',
    'Reassign commits: "Old Name <old@mail>=New Name <new@mail>" (repeatable)',
    (val, prev) => (prev || []).concat([val])
  )
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
  console.log(chalk.bold.red('  🔥 git-vanish') + chalk.bold.white(' — Vanish sensitive files from git history'));
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

  // ── 1a. List authors ───────────────────────────────────
  // Read-only, so it runs before every other mode and exits.
  if (opts.listAuthors) {
    const authors = listAuthors(repoPath);
    console.log(chalk.bold(` ${authors.length} identit${authors.length === 1 ? 'y' : 'ies'} in history:\n`));
    const width = Math.max(...authors.map((a) => `${a.name} <${a.email}>`.length));
    for (const a of authors) {
      const who = `${a.name} <${a.email}>`;
      console.log(`   ${who.padEnd(width)}  ${String(a.count).padStart(6)} refs`);
    }
    console.log(chalk.gray('\n  "refs" counts author + committer entries, so a commit can count twice.'));
    console.log(chalk.gray('  Reassign with:  git-vanish --reassign "Old <old@mail>=New <new@mail>"\n'));
    return;
  }

  // ── 1b. Author reassignment ────────────────────────────
  if (opts.reassign && opts.reassign.length > 0) {
    const pairs = opts.reassign.map((raw) => {
      const at = raw.indexOf('=');
      if (at < 0) {
        console.error(chalk.red(`\n ✘  Bad mapping: ${raw}`));
        console.error(chalk.gray('    Expected:  "Old Name <old@mail>=New Name <new@mail>"\n'));
        process.exit(1);
      }
      return { from: raw.slice(0, at), to: raw.slice(at + 1) };
    });

    const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repoPath, stdio: 'pipe',
    }).stdout.toString().trim();
    if (dirty && !opts.dryRun) {
      console.error(chalk.red('\n ✘  Tracked files are modified.\n'));
      console.error(chalk.gray('    History rewriting rewrites every commit — commit or stash first.\n'));
      process.exit(1);
    }

    console.log(chalk.bold(` Reassigning authorship on ${pairs.length} identit${pairs.length === 1 ? 'y' : 'ies'}:\n`));
    const result = await reassignAuthors(repoPath, pairs, { dryRun: opts.dryRun },
      (msg) => console.log('   ' + msg));

    if (result.changed) {
      console.log(chalk.yellow(`\n  History rewritten. Every commit hash has changed.\n`));
      console.log(chalk.gray('  Files, messages and dates are untouched — only the identity moved.\n'));
      console.log(chalk.cyan('    git remote add origin <your-remote-url>'));
      console.log(chalk.cyan('    git push --force --all'));
      console.log(chalk.cyan('    git push --force --tags\n'));
      console.log(chalk.gray('  Existing clones and forks keep the old identity until they re-clone.\n'));
    }
    return;
  }

  // ── 1c. Redaction mode ─────────────────────────────────
  // Runs instead of the file browser: the file stays tracked, only the
  // secret's bytes are rewritten across every commit.
  const inlineSecrets = opts.secret || [];
  const fileSecrets = opts.secretsFile
    ? fs.readFileSync(path.resolve(opts.secretsFile), 'utf8')
        .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  const secrets = [...inlineSecrets, ...fileSecrets];

  if (secrets.length > 0) {
    const dirty = spawnSync('git', ['status', '--porcelain'], {
      cwd: repoPath, stdio: 'pipe',
    }).stdout.toString().trim();
    if (dirty && !opts.dryRun) {
      console.error(chalk.red('\n ✘  Working tree is not clean.\n'));
      console.error(chalk.gray('    History rewriting rewrites every commit — commit or stash first.\n'));
      process.exit(1);
    }

    console.log(chalk.bold(` Redacting ${secrets.length} secret(s) from all history:\n`));
    const result = await redactSecrets(
      repoPath, secrets,
      { replacement: opts.replacement, dryRun: opts.dryRun },
      (msg) => console.log('   ' + msg)
    );

    if (result.changed) {
      console.log(chalk.yellow(`\n  History rewritten. Every commit hash has changed.\n`));
      console.log(chalk.gray('  filter-repo removes the remote as a safety measure. To publish:\n'));
      console.log(chalk.cyan('    git remote add origin <your-remote-url>'));
      console.log(chalk.cyan('    git push --force --all'));
      console.log(chalk.cyan('    git push --force --tags\n'));
      console.log(chalk.gray('  Everyone else must re-clone — their old clones still contain the secret.\n'));
    }
    return;
  }

  // ── 2. Load all git-tracked files (for the TUI) ────────
  console.log(chalk.gray(' ⏳ Loading file list from git history…'));
  let allTrackedFiles;
  try {
    allTrackedFiles = await getAllTrackedFiles(repoPath);
  } catch (e) {
    allTrackedFiles = null; // still show the browser, just without filtering
  }

  // ── 3. File selection ──────────────────────────────────
  /** @type {string[]} */
  let selectedFiles = [];

  if (opts.file) {
    // normalize slashes, allow comma-separated list
    selectedFiles = opts.file.split(',').map((f) => f.trim().replace(/\\/g, '/'));
    console.log(chalk.cyan(` ℹ  File(s) from --file flag: ${selectedFiles.join(', ')}\n`));
  } else {
    // Open the interactive TUI browser — returns string[]
    selectedFiles = await new Promise((resolve, reject) => {
      const browser = new FileBrowser({
        root:      repoPath,
        gitFiles:  allTrackedFiles,
        title:     '  git-vanish — Select file(s) to vanish from history',
        onSelect:  (files) => resolve(files),
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

  if (!selectedFiles || selectedFiles.length === 0) {
    console.log(chalk.yellow('\n  No files selected.\n'));
    process.exit(0);
  }

  // ── 4-7. Per-file: scan → confirm → scrub ─────────────
  const ora = require('ora');
  const scrubbedFiles = [];

  for (const selectedFile of selectedFiles) {
    console.log(chalk.bold.cyan(`\n ── Processing: ${selectedFile} ──`));

    // 4. Show commits that contain the file
    console.log(chalk.gray('\n ⏳ Searching git history…\n'));
    const commits = await findCommitsForFile(repoPath, selectedFile);

    if (commits.length === 0) {
      console.log(chalk.yellow(` ⚠  "${selectedFile}" was not found in any commit — skipping.\n`));
      continue;
    }

    printCommitList(commits, selectedFile);

    // 5. Dry-run bail-out
    if (opts.dryRun) {
      console.log(chalk.bold.blue(` [DRY RUN] Would scrub "${selectedFile}" from ${commits.length} commit(s).\n`));
      continue;
    }

    // 6. Warnings and per-file confirmation
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
      console.log(chalk.yellow(`\n  Skipped "${selectedFile}". No changes made for this file.\n`));
      continue;
    }

    // 7. Run the scrub
    const spinner = ora({ text: `Rewriting git history for ${selectedFile}…`, color: 'red' }).start();

    let result;
    try {
      result = await scrubFile(repoPath, selectedFile, (msg) => {
        spinner.text = chalk.gray(msg);
      });
      spinner.succeed(chalk.green(`Scrubbed "${selectedFile}" from git history.`));
      scrubbedFiles.push({ file: selectedFile, method: result.method });
    } catch (err) {
      spinner.fail(chalk.red(`Scrub failed for "${selectedFile}".`));
      console.error('\n' + chalk.red(err.message) + '\n');
      console.error(chalk.gray(
        ' Tip: Make sure you have no uncommitted changes before running git-vanish.\n' +
        ' Run: git stash  then try again.\n'
      ));
    }
  }

  if (scrubbedFiles.length === 0) {
    if (!opts.dryRun) console.log(chalk.yellow('\n  Nothing was scrubbed.\n'));
    process.exit(0);
  }

  // ── 8. Opt-in: add scrubbed files to .gitignore ───────
  const remoteUrl = await getRemoteUrl(repoPath);

  const addToIgnore = await confirm(
    `Add ${scrubbedFiles.length} scrubbed file(s) to .gitignore to prevent future accidents?`
  );

  const gitignoreResults = [];
  if (addToIgnore) {
    for (const { file } of scrubbedFiles) {
      const added = addToGitignore(repoPath, file);
      gitignoreResults.push({ file, added });
    }
    // Commit the .gitignore update so the working tree stays clean
    try {
      run('git add .gitignore', repoPath, { silent: true, failOk: true });
      run('git commit -m "chore: add scrubbed files to .gitignore [git-vanish]"', repoPath, { silent: true, failOk: true });
      console.log(chalk.green('\n  ✔  .gitignore updated and committed.\n'));
    } catch {}
  }

  // ── 9. Success summary ─────────────────────────────────
  successBox([
    chalk.bold.green(`  ✔  ${scrubbedFiles.length} file(s) successfully scrubbed from all git history!`),
    '',
    ...scrubbedFiles.map(({ file, method }) =>
      chalk.white(`  ${file}`) + chalk.cyan(`  [${method}]`)
    ),
    '',
    chalk.white(`  .gitignore : `) + (addToIgnore
      ? chalk.green(`${gitignoreResults.filter((r) => r.added).length} entry/entries added`)
      : chalk.gray('skipped (you chose not to add)')),
    chalk.white(`  Working copy: `) + chalk.green('preserved on disk (untracked)'),
    '',
    chalk.gray(`  Your file(s) are still on disk with their latest content.`),
    chalk.gray(`  Git no longer knows they exist — they are now untracked.`),
  ]);

  printForcePushInstructions(repoPath, remoteUrl);
}

main().catch((err) => {
  console.error(chalk.red('\n ✘  Unexpected error: ' + err.message + '\n'));
  process.exit(1);
});
