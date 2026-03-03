'use strict';

/**
 * Terminal confirmation prompt with keyboard support.
 * Single keypress: y/Y → confirm    n/N/Escape/Enter/q/Ctrl+C → deny
 * No Enter required.
 */

const readline = require('readline');
const chalk    = require('chalk');

function confirm(question) {
  return new Promise((resolve) => {
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

/**
 * Show a styled warning box
 */
function warnBox(lines) {
  const W = process.stdout.columns || 80;
  const bar = chalk.red('─'.repeat(W - 2));
  console.log(chalk.red('\n┌' + bar + '┐'));
  for (const line of lines) {
    console.log(chalk.red('│') + ' ' + line);
  }
  console.log(chalk.red('└' + bar + '┘\n'));
}

/**
 * Show a success box
 */
function successBox(lines) {
  const W = process.stdout.columns || 80;
  const bar = chalk.green('─'.repeat(W - 2));
  console.log(chalk.green('\n┌' + bar + '┐'));
  for (const line of lines) {
    console.log(chalk.green('│') + ' ' + line);
  }
  console.log(chalk.green('└' + bar + '┘\n'));
}

module.exports = { confirm, warnBox, successBox };
