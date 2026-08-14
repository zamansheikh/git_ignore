'use strict';

/**
 * git-vanish — entry point.
 *
 * Two ways in, one implementation underneath.
 *
 * With no arguments you get the interactive app: a home screen, then a wizard
 * for whichever operation you pick. That is the path most people want, because
 * the hard part of history rewriting is not running the command — it is
 * knowing exactly what the command is about to do to your repository.
 *
 * With flags you get the same operations non-interactively, for scripts and
 * for people who already know what they want. Anything destructive still
 * refuses to start on a dirty working tree, still reports its scope first, and
 * still verifies the result afterwards.
 */

const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const { program } = require('commander');

const { redactSecrets } = require('./git/redact');
const {
  reassignAuthors, listAuthors, parseMapping, captureRemotes,
} = require('./git/reassign');
const { runApp, vanishFlow, repoStats, dirtyFiles } = require('./ui/flows');

/* ─── CLI setup ──────────────────────────────────────────── */

program
  .name('git-vanish')
  // Read from package.json so --version can never drift from the published release.
  .version(require('../package.json').version)
  .argument('[mode]', 'jump straight to a screen: vanish | redact | reassign | authors')
  .description(
    'Interactively browse your repo and permanently vanish a sensitive file\n' +
    'from all git commit history — the file is preserved on disk as untracked.\n' +
    'Or redact a leaked string from every commit while keeping the file that\n' +
    'contained it, or reassign a contributor\'s commits to another identity.\n\n' +
    'Run with no arguments for the interactive app.'
  )
  .option('-r, --repo <path>',  'Path to the git repository (default: cwd)')
  .option('-f, --file <path>',  'Repo-relative file path to vanish (skip the browser)')
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
const mode = (program.args[0] || '').toLowerCase();

/* ─── helpers ────────────────────────────────────────────── */

function findRepoRoot(startPath) {
  let current = path.resolve(startPath);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** One line, not a wall — the interactive app has its own title bar. */
function banner(repoPath) {
  console.log(
    '\n' + chalk.bold.hex('#ff6b3d')('🔥 git-vanish') +
    chalk.gray(`  v${require('../package.json').version}  ·  ${repoPath}`)
  );
}

function die(message, hint) {
  console.error(chalk.red(`\n ✘  ${message}\n`));
  if (hint) console.error(chalk.gray(`    ${hint}\n`));
  process.exit(1);
}

/** Refuse to start a rewrite on top of uncommitted work. */
function requireCleanTree(repoPath) {
  if (opts.dryRun) return;
  const dirty = dirtyFiles(repoPath);
  if (dirty.length === 0) return;
  die(
    'Tracked files are modified.',
    'History rewriting replays every commit — commit or stash first.'
  );
}

function printPublishSteps(remotes) {
  console.log(chalk.gray('\n  git-filter-repo removes remotes so a bad rewrite cannot be pushed by accident.'));
  console.log(chalk.gray('  To publish this history:\n'));
  if (remotes && remotes.length) {
    for (const r of remotes) console.log(chalk.cyan(`    git remote add ${r.name} ${r.url}`));
  } else {
    console.log(chalk.cyan('    git remote add origin <your-remote-url>'));
  }
  console.log(chalk.cyan('    git push --force --all'));
  console.log(chalk.cyan('    git push --force --tags\n'));
}

/* ─── non-interactive: list authors ──────────────────────── */

function runListAuthors(repoPath) {
  const people = listAuthors(repoPath);
  console.log(chalk.bold(`\n ${people.length} identit${people.length === 1 ? 'y' : 'ies'} in history:\n`));

  if (people.length === 0) {
    console.log(chalk.gray('   No commits yet.\n'));
    return;
  }

  const width = Math.max(...people.map((p) => `${p.name} <${p.email}>`.length));
  console.log(chalk.gray(
    '   ' + 'identity'.padEnd(width) + 'authored'.padStart(10) + 'committed'.padStart(12) + 'total'.padStart(8)
  ));
  for (const p of people) {
    console.log(
      '   ' + `${p.name} <${p.email}>`.padEnd(width)
      + chalk.cyan(String(p.authored).padStart(10))
      + chalk.gray(String(p.committed).padStart(12))
      + chalk.white(String(p.count).padStart(8))
    );
  }
  console.log(chalk.gray(
    '\n  "committed" counts commits someone applied but did not write — rebases and squashed\n' +
    '  merges leave these behind, and a reassignment has to catch them too.\n'
  ));
  console.log(chalk.gray('  Reassign with:  ') + chalk.cyan('git-vanish --reassign "Old <old@mail>=New <new@mail>"\n'));
}

/* ─── non-interactive: reassign ──────────────────────────── */

async function runReassign(repoPath) {
  const pairs = opts.reassign.map((raw) => {
    const parsed = parseMapping(raw);
    if (!parsed) {
      die(`Bad mapping: ${raw}`, 'Expected:  "Old Name <old@mail>=New Name <new@mail>"');
    }
    return parsed;
  });

  requireCleanTree(repoPath);

  console.log(chalk.bold(`\n Reassigning authorship on ${pairs.length} identit${pairs.length === 1 ? 'y' : 'ies'}:\n`));

  const result = await reassignAuthors(
    repoPath, pairs, { dryRun: opts.dryRun },
    (msg) => console.log('   ' + msg)
  );

  if (!result.changed) return;

  console.log(chalk.green(`\n  ✓  ${result.commits} commits kept, authorship moved.\n`));
  console.log(chalk.gray('  Files, messages and dates are untouched — only the identity changed.'));
  printPublishSteps(result.remotes);
  console.log(chalk.gray('  Existing clones and forks keep the old identity until they re-clone.\n'));
}

/* ─── non-interactive: redact ────────────────────────────── */

async function runRedact(repoPath, secrets) {
  requireCleanTree(repoPath);

  console.log(chalk.bold(`\n Redacting ${secrets.length} secret(s) from all history:\n`));
  const remotes = captureRemotes(repoPath);

  const result = await redactSecrets(
    repoPath, secrets,
    { replacement: opts.replacement, dryRun: opts.dryRun },
    (msg) => console.log('   ' + msg)
  );

  if (!result.changed) return;

  console.log(chalk.green('\n  ✓  Secret(s) removed from every commit.\n'));
  printPublishSteps(remotes);
  console.log(chalk.gray('  Everyone else must re-clone — their old clones still contain the secret.\n'));
}

/* ─── main ───────────────────────────────────────────────── */

async function main() {
  const startDir = opts.repo ? path.resolve(opts.repo) : process.cwd();
  const repoPath = findRepoRoot(startDir);

  if (!repoPath) {
    die(
      `No git repository found at or above: ${startDir}`,
      'Run this command from inside a git repository, or use --repo <path>.'
    );
  }

  // ── Non-interactive paths, in the order they short-circuit ──

  if (opts.listAuthors) { banner(repoPath); return runListAuthors(repoPath); }
  if (opts.reassign && opts.reassign.length > 0) { banner(repoPath); return runReassign(repoPath); }

  const secrets = [
    ...(opts.secret || []),
    ...(opts.secretsFile
      ? fs.readFileSync(path.resolve(opts.secretsFile), 'utf8')
          .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      : []),
  ];
  if (secrets.length > 0) { banner(repoPath); return runRedact(repoPath, secrets); }

  // ── Interactive from here on ──

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die(
      'The interactive app needs a terminal.',
      'Use the flags instead — see: git-vanish --help'
    );
  }

  const ctx = {
    repoPath,
    repoName: path.basename(repoPath),
    dryRun: !!opts.dryRun,
    stats: repoStats(repoPath),
  };

  // --file preselects the browser's result but keeps every review and
  // confirmation screen: skipping the picker is not consent to a rewrite.
  if (opts.file) {
    const { Ui } = require('./ui/ui');
    const ui = new Ui();
    ui.open();
    try {
      const files = opts.file.split(',').map((f) => f.trim().replace(/\\/g, '/')).filter(Boolean);
      await vanishFlow(ui, ctx, files);
    } finally {
      ui.close();
    }
    return;
  }

  if (mode) {
    const known = { vanish: 1, redact: 1, reassign: 1, authors: 1, contributors: 1 };
    if (!known[mode]) {
      die(`Unknown mode: ${mode}`, 'Expected one of: vanish, redact, reassign, authors');
    }
    ctx.startAt = mode === 'contributors' ? 'authors' : mode;
  }

  await runApp(ctx);
}

main().catch((err) => {
  // The TUI restores the terminal from its own exit hook; this is the last
  // line of defence for anything that escapes it.
  process.stdout.write('\x1b[?25h\x1b[?1000l\x1b[?1006l');
  console.error(chalk.red('\n ✘  ' + (err && err.message ? err.message : String(err)) + '\n'));
  process.exit(1);
});
