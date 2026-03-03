'use strict';

/**
 * Terminal confirmation prompt with keyboard support.
 * y/Y/Enter → confirm    n/N/Escape/q → deny
 */

const readline = require('readline');
const chalk    = require('chalk');

function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input:  process.stdin,
      output: process.stdout,
    });

    const ask = () => {
      rl.question(
        chalk.bold.yellow('\n ⚠️  ') + chalk.bold(question) + chalk.gray('  [y/N] ') + chalk.white('→ '),
        (ans) => {
          rl.close();
          resolve(ans.trim().toLowerCase() === 'y');
        }
      );
    };

    ask();
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
