'use strict';

/**
 * A single-keypress yes/no prompt for the plain terminal.
 *
 * The wizards ask their questions with the full-screen dialog in `ui.js`. This
 * one is for the questions that come AFTER a rewrite, once we have handed the
 * terminal back — "shall I put your remote back?" belongs in the scrollback
 * next to the commands it relates to, not in a screen that erases itself.
 *
 * y/Y confirms; n/N/Escape/Enter/q/Ctrl+C denies. No Enter required.
 */

const readline = require('readline');
const chalk    = require('chalk');

function confirm(question) {
  return new Promise((resolve) => {
    // Without a terminal there is nobody to answer. Treat silence as "no":
    // every caller's question guards an action, so defaulting to yes would
    // let a piped or CI run take a step the user never approved.
    if (!process.stdin.isTTY) {
      process.stdout.write(chalk.gray(`\n ⚠️  ${question}  [skipped — not a terminal]\n`));
      resolve(false);
      return;
    }

    process.stdout.write(
      chalk.bold.yellow('\n ⚠️  ') + chalk.bold(question) +
      chalk.gray('  [y/N] ') + chalk.white('→ ')
    );

    // Ensure stdin is in the right state
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isTTY && process.stdin.isRaw;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function onKey(ch, key) {
      if (!key && !ch) return;

      const char    = ch || '';
      const keyName = (key && key.name) || '';
      const isCtrlC = key && key.ctrl && keyName === 'c';

      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY && !wasRaw) process.stdin.setRawMode(false);
      process.stdin.pause();

      if (char.toLowerCase() === 'y') {
        process.stdout.write(chalk.green('y') + '\n');
        resolve(true);
      } else {
        const display = isCtrlC ? '^C' : 'n';
        process.stdout.write(chalk.gray(display) + '\n');
        resolve(false);
      }
    }

    process.stdin.on('keypress', onKey);
  });
}

module.exports = { confirm };
