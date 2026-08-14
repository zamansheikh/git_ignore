'use strict';

/**
 * Terminal UI core — the pieces every screen in git-vanish is built from.
 *
 * Three things live here:
 *
 *  1. Width-aware text helpers. A terminal cell is not a JavaScript character:
 *     colour codes are zero cells, emoji are two. Padding a coloured, emoji-
 *     bearing string with `String.padEnd` tears the box borders apart, so all
 *     layout goes through `fit()`.
 *
 *  2. `Screen` — the alternate screen buffer. Entering it gives us a window of
 *     our own: the user's scrollback is untouched while we run and comes back
 *     exactly as it was when we exit. Frames are painted by homing the cursor
 *     and erasing each line as we overwrite it, never by clearing the whole
 *     screen, which is what causes the flicker in naive TUIs.
 *
 *  3. `Keyboard` — a raw stdin decoder for keys AND mouse. Node's readline
 *     keypress emitter cannot see mouse reports, and clicking and scrolling
 *     are most of what makes a terminal app feel like a GUI, so we parse the
 *     escape sequences ourselves.
 */

const EventEmitter = require('events');
const chalk = require('chalk');

/* ─── text measurement ───────────────────────────────────── */

const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ONE = /^\x1B\[[0-?]*[ -/]*[@-~]/;

function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

/**
 * Cells occupied by one code point.
 * Zero for combining marks and the variation selectors that follow an emoji,
 * two for the CJK and emoji blocks, one for everything else.
 */
function charWidth(cp) {
  if (cp === 0x200d) return 0;                    // zero-width joiner
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;     // variation selectors
  if (cp >= 0x0300 && cp <= 0x036f) return 0;     // combining diacriticals
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||             // hangul jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||             // CJK radicals … punctuation
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||             // hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||             // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||           // emoji
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff)
  ) return 2;
  return 1;
}

function stringWidth(str) {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

/**
 * Cut a string to `max` cells, keeping colour codes intact and closing any
 * that were left open by the cut.
 */
function truncate(str, max, ellipsis = '…') {
  const s = String(str);
  if (max <= 0) return '';
  if (stringWidth(s) <= max) return s;

  const tail = ellipsis ? stringWidth(ellipsis) : 0;
  const budget = Math.max(0, max - tail);

  let out = '';
  let w = 0;
  let i = 0;
  let coloured = false;

  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = ANSI_ONE.exec(s.slice(i));
      if (m) { out += m[0]; coloured = true; i += m[0].length; continue; }
    }
    const cp = s.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    const cw = charWidth(cp);
    if (w + cw > budget) break;
    out += s.slice(i, i + len);
    w += cw;
    i += len;
  }

  return out + (ellipsis || '') + (coloured ? '\x1b[0m' : '');
}

/** Truncate to `width` cells, then pad to exactly `width`. */
function fit(str, width, align = 'left') {
  const cut = truncate(str, width);
  const gap = Math.max(0, width - stringWidth(cut));
  if (gap === 0) return cut;
  if (align === 'right') return ' '.repeat(gap) + cut;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + cut + ' '.repeat(gap - left);
  }
  return cut + ' '.repeat(gap);
}

/* ─── palette ────────────────────────────────────────────── */

const theme = {
  brand:    chalk.bold.hex('#ff6b3d'),
  titleBar: chalk.bgHex('#1f2430').hex('#ffffff').bold,
  helpBar:  chalk.bgHex('#1f2430').hex('#9aa4b2'),
  key:      chalk.bgHex('#3b4252').hex('#e5e9f0').bold,
  selected: chalk.bgHex('#2d5f8b').hex('#ffffff').bold,
  chosen:   chalk.hex('#7ee787'),
  dim:      chalk.hex('#7d8590'),
  label:    chalk.hex('#adbac7'),
  accent:   chalk.hex('#58a6ff'),
  danger:   chalk.hex('#ff7b72'),
  warn:     chalk.hex('#e3b341'),
  ok:       chalk.hex('#3fb950'),
  rule:     chalk.hex('#30363d'),
};

/* ─── glyphs (all single-cell, so layout stays honest) ───── */

const G = {
  cursor:   '▸',
  check:    '✓',
  radioOn:  '●',
  radioOff: '○',
  up:       '▲',
  down:     '▼',
  bar:      '│',
  thumb:    '┃',
  tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│',
};

/* ─── screen ─────────────────────────────────────────────── */

class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.isOpen = false;
    this._onResize = null;
  }

  get width()  { return Math.max(48, this.out.columns || 80); }
  get height() { return Math.max(12, this.out.rows || 24); }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    // 1049: alternate buffer. 25l: hide cursor.
    this.out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    if (mouseEnabled()) this.out.write('\x1b[?1000h\x1b[?1006h');
    this._onResize = () => this.emitResize && this.emitResize();
    this.out.on('resize', this._onResize);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    if (this._onResize) this.out.removeListener('resize', this._onResize);
    if (mouseEnabled()) this.out.write('\x1b[?1000l\x1b[?1006l');
    this.out.write('\x1b[?25h\x1b[?1049l');
  }

  /**
   * Paint one frame. Erasing per line as we overwrite (`\x1b[K`) rather than
   * clearing first is what keeps this flicker-free; `\x1b[J` at the end wipes
   * whatever the previous, taller frame left below.
   */
  render(lines) {
    const frame = lines.slice(0, this.height);
    let buf = '\x1b[H';
    for (let i = 0; i < frame.length; i++) {
      buf += frame[i] + '\x1b[0m\x1b[K';
      if (i < frame.length - 1) buf += '\r\n';
    }
    this.out.write(buf + '\x1b[J');
  }
}

function mouseEnabled() {
  return !process.env.GIT_VANISH_NO_MOUSE;
}

/* ─── keyboard + mouse ───────────────────────────────────── */

const SEQ = {
  '[A': 'up',    '[B': 'down',  '[C': 'right', '[D': 'left',
  'OA': 'up',    'OB': 'down',  'OC': 'right', 'OD': 'left',
  '[H': 'home',  '[F': 'end',   'OH': 'home',  'OF': 'end',
  '[1~': 'home', '[7~': 'home', '[4~': 'end',  '[8~': 'end',
  '[5~': 'pageup', '[6~': 'pagedown',
  '[3~': 'delete', '[2~': 'insert',
  '[Z': 'shifttab',
};

/** Turn a raw stdin chunk into key / mouse events. */
function decode(chunk) {
  const s = chunk.toString('utf8');
  const events = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];

    if (ch === '\x1b') {
      const rest = s.slice(i);

      // SGR mouse report: ESC [ < button ; col ; row (M|m)
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(rest);
      if (mouse) {
        const btn = parseInt(mouse[1], 10);
        events.push({
          type: 'mouse',
          x: parseInt(mouse[2], 10),
          y: parseInt(mouse[3], 10),
          pressed: mouse[4] === 'M',
          wheel: btn === 64 ? 'up' : btn === 65 ? 'down' : null,
          button: btn,
        });
        i += mouse[0].length;
        continue;
      }

      let matched = null;
      for (const seq of Object.keys(SEQ)) {
        if (rest.startsWith('\x1b' + seq)) {
          if (!matched || seq.length > matched.length) matched = seq;
        }
      }
      if (matched) {
        events.push({ type: 'key', name: SEQ[matched], ch: '' });
        i += 1 + matched.length;
        continue;
      }

      // Alt+<char> arrives as ESC followed by the character.
      if (rest.length > 1 && rest[1] !== '\x1b' && rest[1] >= ' ') {
        events.push({ type: 'key', name: rest[1], ch: rest[1], meta: true });
        i += 2;
        continue;
      }

      events.push({ type: 'key', name: 'escape', ch: '' });
      i += 1;
      continue;
    }

    if (ch === '\r' || ch === '\n') { events.push({ type: 'key', name: 'return', ch: '' }); i++; continue; }
    if (ch === '\t')                { events.push({ type: 'key', name: 'tab', ch: '' });    i++; continue; }
    if (ch === '\x7f' || ch === '\b') { events.push({ type: 'key', name: 'backspace', ch: '' }); i++; continue; }

    const code = ch.charCodeAt(0);
    if (code < 0x20) {
      // Control characters: 0x01 is ctrl+a, 0x1a is ctrl+z.
      events.push({ type: 'key', name: String.fromCharCode(code + 96), ch: '', ctrl: true });
      i++;
      continue;
    }

    // Printable — take the whole code point so astral characters survive.
    const cp = s.codePointAt(i);
    const len = cp > 0xffff ? 2 : 1;
    const char = s.slice(i, i + len);
    events.push({ type: 'key', name: char, ch: char });
    i += len;
  }

  return events;
}

class Keyboard extends EventEmitter {
  constructor(input = process.stdin) {
    super();
    this.input = input;
    this.started = false;
    this._handler = (chunk) => {
      for (const ev of decode(chunk)) {
        if (ev.type === 'mouse') this.emit('mouse', ev);
        else this.emit('key', ev);
      }
    };
    // A real terminal never sends EOF, so this only fires when input was piped
    // or redirected. Without it the app sits on a screen nobody can answer.
    this._endHandler = () => this.emit('end');
  }

  start() {
    if (this.started) return;
    this.started = true;
    if (this.input.isTTY) this.input.setRawMode(true);
    this.input.resume();
    this.input.on('data', this._handler);
    this.input.on('end', this._endHandler);
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    this.input.removeListener('data', this._handler);
    this.input.removeListener('end', this._endHandler);
    if (this.input.isTTY) this.input.setRawMode(false);
    this.input.pause();
  }
}

/* ─── layout ─────────────────────────────────────────────── */

/** `[['↑↓','move'], ['enter','open']]` → a row of key chips for the help bar. */
function keyHints(pairs) {
  return pairs
    .map(([k, label]) => theme.key(` ${k} `) + theme.helpBar(' ' + label))
    .join(theme.helpBar('   '));
}

/**
 * The window frame every screen shares: a title bar at the top, a help bar
 * pinned to the bottom, and the body filling whatever is left. The fixed
 * chrome is what stops screens from jumping around as you move between them.
 */
function chrome(screen, { title, crumb = '', right = '', body = [], help = '', status = '' }) {
  const W = screen.width;
  const H = screen.height;
  const lines = [];

  const brand = ' 🔥 git-vanish ';
  const rightTxt = right ? ` ${right} ` : '';
  const head = brand + (crumb ? theme.dim.inverse(' › ') : '') + (crumb || '');
  const headWidth = W - stringWidth(rightTxt);
  lines.push(theme.titleBar(fit(head, headWidth)) + theme.titleBar(rightTxt));

  if (title) {
    lines.push('');
    lines.push(truncate(' ' + chalk.bold.white(title) + (status ? '   ' + status : ''), W));
    lines.push(' ' + theme.rule('─'.repeat(Math.max(0, W - 2))));
  }

  const used = lines.length + 2; // + help bar + spacer
  const room = Math.max(1, H - used);
  // Callers write body text, not rows: a multi-line note is one natural string.
  // Split it here, and clamp the width — one over-long line would wrap and push
  // the help bar off the bottom, breaking the layout for every screen below.
  const flat = [];
  for (const line of body) {
    for (const part of String(line).split('\n')) flat.push(truncate(part, W));
  }
  const shown = flat.slice(0, room);
  for (const line of shown) lines.push(line);
  for (let i = shown.length; i < room; i++) lines.push('');

  lines.push('');
  lines.push(theme.helpBar(fit(' ' + help, W)));
  return lines;
}

/**
 * A vertical scrollbar column, one character per visible row. Rendered as its
 * own column so long lists show position at a glance, the way a GUI list does.
 */
function scrollbar(total, visible, offset) {
  if (total <= visible) return new Array(visible).fill(' ');
  const thumbLen = Math.max(1, Math.round((visible / total) * visible));
  const maxOffset = total - visible;
  const top = Math.round((offset / maxOffset) * (visible - thumbLen));
  return new Array(visible).fill(0).map((_, i) =>
    i >= top && i < top + thumbLen ? theme.accent(G.thumb) : theme.rule(G.bar)
  );
}

module.exports = {
  stripAnsi, stringWidth, truncate, fit,
  theme, G, keyHints, chrome, scrollbar,
  Screen, Keyboard, decode, mouseEnabled,
};
