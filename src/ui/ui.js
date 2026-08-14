'use strict';

/**
 * The widget layer: menus, checklists, forms, dialogs.
 *
 * Every screen is a plain object with `frame()` and event handlers, driven by
 * one `Ui` instance that owns the screen and the keyboard for the whole
 * session. Sharing them matters — opening and closing the alternate buffer
 * between screens is what makes a TUI blink; here the user moves between
 * screens inside one continuous window, like pages in an application.
 *
 * Interaction is deliberately redundant: arrows or vi keys, Enter or a mouse
 * click, Escape or `q`. People arrive with different habits, and a terminal
 * app that accepts only one of them feels like a puzzle.
 *
 * One layout rule holds everywhere: build each row as PLAIN text fitted to an
 * exact cell width, and colour it last. Colouring first and padding after
 * leaves the highlight bar ending mid-row.
 */

const {
  theme, G, fit, stringWidth, keyHints, chrome, scrollbar,
  Screen, Keyboard, mouseEnabled,
} = require('./tui');
const chalk = require('chalk');

/** Terminal row (1-based) where a titled screen's body starts. */
const BODY_TOP = 5;

/** Keep the cursor inside the window, scrolling the viewport if it left. */
function reflow(cursor, total, height, offset) {
  if (total <= height) return 0;
  let next = offset;
  if (cursor < next) next = cursor;
  if (cursor >= next + height) next = cursor - height + 1;
  return Math.max(0, Math.min(next, total - height));
}

/**
 * A two-column row — label on the left, dim detail flush right — laid out in
 * plain text so a caller can paint the whole thing as one highlight.
 */
function twoCol(left, right, width) {
  if (!right) return fit(left, width);
  const rightW = Math.min(stringWidth(right), Math.max(0, width - 12));
  const leftW = Math.max(0, width - rightW - 2);
  return fit(left, leftW) + '  ' + fit(right, rightW, 'right');
}

class Ui {
  constructor() {
    this.screen = new Screen();
    this.kb = new Keyboard();
    this.view = null;
    this._exitHook = null;
  }

  get width()  { return this.screen.width; }
  get height() { return this.screen.height; }

  open() {
    if (this.screen.isOpen) return;
    this.screen.open();
    this.kb.start();

    // If anything throws or the process is killed we must still hand the
    // terminal back with its cursor visible and mouse reporting off. A shell
    // left with a hidden cursor and mouse reporting on is unusable, and the
    // user has no obvious way to know that `reset` is what they need.
    if (!this._exitHook) {
      this._exitHook = () => this.close();
      process.on('exit', this._exitHook);
      this._signalHook = () => { this.close(); process.exit(130); };
      process.once('SIGINT', this._signalHook);
      process.once('SIGTERM', this._signalHook);
      process.once('SIGHUP', this._signalHook);
    }

    if (!this._wired) {
      this._wired = true;
      this.kb.on('key', (ev) => {
        if (!this.view) return;
        if (ev.ctrl && ev.name === 'c') return this._finish(null, true);
        this.view.onKey(ev, this._api());
        this.draw();
      });
      this.kb.on('mouse', (ev) => {
        if (!this.view || !this.view.onMouse) return;
        this.view.onMouse(ev, this._api());
        this.draw();
      });
      // Input ran out with a screen still up: there is no one left to answer,
      // so leave without doing anything rather than hanging on a prompt.
      this.kb.on('end', () => {
        if (!this.view) return;
        this.close();
        process.exit(0);
      });
      this.screen.emitResize = () => this.draw();
    }
  }

  close() {
    if (this._exitHook) {
      process.removeListener('exit', this._exitHook);
      this._exitHook = null;
    }
    if (this._signalHook) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.removeListener(sig, this._signalHook);
      }
      this._signalHook = null;
    }
    this.kb.stop();
    this.screen.close();
  }

  /**
   * Hand the terminal back, run something that owns stdio (a git rewrite
   * streaming its own output), then optionally return to the TUI. Destructive
   * work belongs in the real scrollback, where the user can still read it
   * tomorrow.
   */
  async suspend(fn, { resume = false } = {}) {
    const wasOpen = this.screen.isOpen;
    this.close();
    try {
      return await fn();
    } finally {
      if (resume && wasOpen) this.open();
    }
  }

  draw() {
    if (this.view) this.screen.render(this.view.frame(this.screen));
  }

  _api() {
    return { done: (value) => this._finish(value) };
  }

  _finish(value, interrupted = false) {
    const view = this.view;
    this.view = null;
    if (view && view._resolve) view._resolve(interrupted ? null : value);
    if (interrupted) {
      this.close();
      process.exit(130);
    }
  }

  _run(view) {
    return new Promise((resolve) => {
      view._resolve = resolve;
      this.view = view;
      this.draw();
    });
  }

  /* ─── menu: pick one of a list ─────────────────────────── */

  /**
   * @param {Array<{label, hint?, icon?, value, disabled?}>} items
   * @returns the chosen item's `value`, or null on cancel
   */
  menu({ title, crumb, right, items, help, note }) {
    let cursor = items.findIndex((i) => !i.disabled);
    if (cursor < 0) cursor = 0;
    let offset = 0;

    const view = {
      frame(screen) {
        const W = screen.width;
        const noteRows = note ? 2 : 0;
        const height = Math.max(3, Math.min(items.length, screen.height - 7 - noteRows));
        offset = reflow(cursor, items.length, height, offset);
        const bar = scrollbar(items.length, height, offset);
        const inner = W - 6;
        const body = [];

        items.slice(offset, offset + height).forEach((item, i) => {
          const idx = i + offset;
          const active = idx === cursor;
          const icon = item.icon ? item.icon + '  ' : '';
          const row = twoCol(` ${icon}${item.label}`, item.hint || '', inner);

          let painted;
          if (item.disabled)  painted = theme.dim(row);
          else if (active)    painted = theme.selected(row);
          else {
            // Re-split so only the detail column is dimmed.
            const rightW = item.hint ? Math.min(stringWidth(item.hint), Math.max(0, inner - 12)) : 0;
            const leftW = rightW ? inner - rightW - 2 : inner;
            painted = chalk.white(fit(` ${icon}${item.label}`, leftW))
              + (rightW ? '  ' + theme.dim(fit(item.hint, rightW, 'right')) : '');
          }

          const marker = active ? theme.accent(G.cursor) : ' ';
          const num = active ? theme.selected(String(idx + 1).padStart(2)) : theme.dim(String(idx + 1).padStart(2));
          body.push(` ${marker}${num} ${painted}${bar[i] || ''}`);
        });

        if (note) { body.push(''); body.push(' ' + note); }

        return chrome(screen, {
          title, crumb, right, body,
          help: help || keyHints([
            ['↑↓', 'move'], ['1-9', 'jump'], ['enter', 'select'],
            ...(mouseEnabled() ? [['click', 'select']] : []),
            ['esc', 'back'],
          ]),
        });
      },

      _move(delta) {
        let next = cursor;
        for (let n = 0; n < items.length; n++) {
          const candidate = Math.max(0, Math.min(items.length - 1, next + delta));
          if (candidate === next) break;
          next = candidate;
          if (!items[next].disabled) break;
        }
        if (!items[next].disabled) cursor = next;
      },

      onKey(ev, api) {
        const k = ev.name;
        if (k === 'up' || k === 'k')        this._move(-1);
        else if (k === 'down' || k === 'j') this._move(1);
        else if (k === 'home')              cursor = 0;
        else if (k === 'end')               cursor = items.length - 1;
        else if (k === 'pageup')            this._move(-5);
        else if (k === 'pagedown')          this._move(5);
        else if (k === 'return' || k === 'right' || ev.ch === ' ') {
          const item = items[cursor];
          if (item && !item.disabled) api.done(item.value);
        } else if (k === 'escape' || k === 'q') api.done(null);
        else if (/^[1-9]$/.test(ev.ch || '')) {
          const idx = parseInt(ev.ch, 10) - 1;
          if (items[idx] && !items[idx].disabled) { cursor = idx; api.done(items[idx].value); }
        }
      },

      onMouse(ev, api) {
        if (ev.wheel === 'up')   return this._move(-1);
        if (ev.wheel === 'down') return this._move(1);
        if (!ev.pressed) return;
        const idx = ev.y - BODY_TOP + offset;
        if (idx >= 0 && idx < items.length && !items[idx].disabled) {
          cursor = idx;
          api.done(items[idx].value);
        }
      },
    };

    return this._run(view);
  }

  /* ─── checklist: pick several ──────────────────────────── */

  /**
   * @param {Array<{label, hint?, value}>} items
   * @returns array of chosen `value`s, or null on cancel
   */
  checklist({ title, crumb, right, items, help, note, minimum = 1 }) {
    let cursor = 0;
    let offset = 0;
    const chosen = new Set();

    const view = {
      frame(screen) {
        const W = screen.width;
        const noteRows = note ? 2 : 0;
        const height = Math.max(3, Math.min(items.length, screen.height - 7 - noteRows));
        offset = reflow(cursor, items.length, height, offset);
        const bar = scrollbar(items.length, height, offset);
        const inner = W - 9;
        const body = [];

        items.slice(offset, offset + height).forEach((item, i) => {
          const idx = i + offset;
          const active = idx === cursor;
          const on = chosen.has(idx);
          const box = on ? theme.chosen(`[${G.check}]`) : theme.dim('[ ]');
          const row = twoCol(item.label, item.hint || '', inner);

          let painted;
          if (active)   painted = theme.selected(row);
          else if (on)  painted = theme.chosen(row);
          else {
            const rightW = item.hint ? Math.min(stringWidth(item.hint), Math.max(0, inner - 12)) : 0;
            const leftW = rightW ? inner - rightW - 2 : inner;
            painted = chalk.white(fit(item.label, leftW))
              + (rightW ? '  ' + theme.dim(fit(item.hint, rightW, 'right')) : '');
          }

          const marker = active ? theme.accent(G.cursor) : ' ';
          body.push(` ${marker} ${box} ${painted}${bar[i] || ''}`);
        });

        if (note) { body.push(''); body.push(' ' + note); }

        return chrome(screen, {
          title, crumb, right, body,
          status: chosen.size ? theme.chosen(`${chosen.size} selected`) : theme.dim('none selected'),
          help: help || keyHints([
            ['space', 'toggle'], ['a', 'all'], ['n', 'none'],
            ['enter', 'continue'], ['esc', 'back'],
          ]),
        });
      },

      onKey(ev, api) {
        const k = ev.name;
        if (k === 'up' || k === 'k')        cursor = Math.max(0, cursor - 1);
        else if (k === 'down' || k === 'j') cursor = Math.min(items.length - 1, cursor + 1);
        else if (k === 'home')              cursor = 0;
        else if (k === 'end')               cursor = items.length - 1;
        else if (k === 'pageup')            cursor = Math.max(0, cursor - 5);
        else if (k === 'pagedown')          cursor = Math.min(items.length - 1, cursor + 5);
        else if (ev.ch === ' ') {
          if (chosen.has(cursor)) chosen.delete(cursor); else chosen.add(cursor);
          cursor = Math.min(items.length - 1, cursor + 1);
        } else if (ev.ch === 'a') items.forEach((_, i) => chosen.add(i));
        else if (ev.ch === 'n')   chosen.clear();
        else if (k === 'return') {
          // Enter with nothing ticked means "the one I'm looking at" — the
          // common case shouldn't require learning the Space key first.
          if (chosen.size === 0) chosen.add(cursor);
          if (chosen.size >= minimum) {
            api.done([...chosen].sort((a, b) => a - b).map((i) => items[i].value));
          }
        } else if (k === 'escape' || k === 'q') api.done(null);
      },

      onMouse(ev) {
        if (ev.wheel === 'up')   return void (cursor = Math.max(0, cursor - 3));
        if (ev.wheel === 'down') return void (cursor = Math.min(items.length - 1, cursor + 3));
        if (!ev.pressed) return;
        const idx = ev.y - BODY_TOP + offset;
        if (idx >= 0 && idx < items.length) {
          cursor = idx;
          if (chosen.has(idx)) chosen.delete(idx); else chosen.add(idx);
        }
      },
    };

    return this._run(view);
  }

  /* ─── form: typed fields ───────────────────────────────── */

  /**
   * @param {Array<{name, label, value?, placeholder?, hint?, validate?}>} fields
   * @returns {Promise<object|null>} field name → trimmed value
   */
  form({ title, crumb, right, fields, intro, submitLabel = 'Continue' }) {
    // `pristine` marks a prefilled value the user has not touched. Typing over
    // it replaces the whole thing, the way a text box whose content is selected
    // behaves in a GUI — otherwise every preset has to be erased by hand first.
    const state = fields.map((f) => ({
      ...f,
      value: f.value || '',
      caret: (f.value || '').length,
      pristine: !!f.value,
    }));
    let focus = 0;
    const ROWS_PER_FIELD = 5;

    const errorFor = (f) => (f.validate ? f.validate(f.value.trim(), state) : null);
    const firstError = () => {
      for (const f of state) { const e = errorFor(f); if (e) return e; }
      return null;
    };

    const view = {
      frame(screen) {
        const W = screen.width;
        const boxW = Math.min(70, W - 6);
        const body = [];

        if (intro) {
          for (const line of intro) body.push('  ' + line);
          body.push('');
        }

        state.forEach((f, i) => {
          const active = i === focus;
          const err = errorFor(f);

          body.push('  ' + (active ? theme.accent.bold(f.label) : theme.label(f.label))
            + (f.hint ? '  ' + theme.dim(f.hint) : ''));

          // Drawn as a box so it reads as an input, with a block caret at the
          // insertion point when focused.
          let content;
          if (active && !f.value) {
            // Keep the placeholder visible behind the caret: an empty focused
            // field that says nothing is the commonest way to strand someone.
            content = chalk.inverse(' ') + theme.dim(f.placeholder || '');
          } else if (active && f.pristine) {
            content = chalk.inverse(f.value);   // shown as selected: typing replaces it
          } else if (active) {
            const before = f.value.slice(0, f.caret);
            const at = f.value.slice(f.caret, f.caret + 1) || ' ';
            const after = f.value.slice(f.caret + 1);
            content = chalk.white(before) + chalk.inverse(at) + chalk.white(after);
          } else if (f.value) {
            content = chalk.white(f.value);
          } else {
            content = theme.dim(f.placeholder || '');
          }

          const border = (err && f.value) ? theme.danger : active ? theme.accent : theme.rule;
          body.push('  ' + border(G.tl + G.h.repeat(boxW) + G.tr));
          body.push('  ' + border(G.v) + ' ' + fit(content, boxW - 2) + ' ' + border(G.v));
          body.push('  ' + border(G.bl + G.h.repeat(boxW) + G.br));
          body.push('  ' + ((err && f.value) ? theme.danger(' ' + err) : ''));
        });

        const blocking = firstError();
        body.push('');
        body.push('  ' + (blocking
          ? theme.dim(`[ ${submitLabel} ]`) + '   ' + theme.dim(blocking)
          : chalk.bgGreen.black.bold(` ${submitLabel} `) + theme.dim('   press Enter')));

        return chrome(screen, {
          title, crumb, right, body,
          help: keyHints([['tab', 'next field'], ['↑↓', 'move'], ['enter', submitLabel.toLowerCase()], ['esc', 'back']]),
        });
      },

      onKey(ev, api) {
        const f = state[focus];
        const k = ev.name;

        if (k === 'escape') return api.done(null);
        if (k === 'tab' || k === 'down')    return void (focus = (focus + 1) % state.length);
        if (k === 'shifttab' || k === 'up') return void (focus = (focus - 1 + state.length) % state.length);
        if (k === 'return') {
          if (focus < state.length - 1) return void focus++;
          if (!firstError()) {
            const out = {};
            for (const field of state) out[field.name] = field.value.trim();
            api.done(out);
          }
          return;
        }
        // Any deliberate edit or cursor move means the user is amending the
        // preset rather than replacing it, so stop treating it as selected.
        const touch = () => { f.pristine = false; };

        if (k === 'left')  { touch(); return void (f.caret = Math.max(0, f.caret - 1)); }
        if (k === 'right') { touch(); return void (f.caret = Math.min(f.value.length, f.caret + 1)); }
        if (k === 'home')  { touch(); return void (f.caret = 0); }
        if (k === 'end')   { touch(); return void (f.caret = f.value.length); }
        if (k === 'backspace') {
          if (f.pristine) { f.value = ''; f.caret = 0; touch(); return; }
          if (f.caret > 0) {
            f.value = f.value.slice(0, f.caret - 1) + f.value.slice(f.caret);
            f.caret--;
          }
          return;
        }
        if (k === 'delete') {
          if (f.pristine) { f.value = ''; f.caret = 0; touch(); return; }
          f.value = f.value.slice(0, f.caret) + f.value.slice(f.caret + 1);
          return;
        }
        if (ev.ctrl && k === 'u') { f.value = ''; f.caret = 0; touch(); return; }
        if (ev.ctrl && k === 'a') { touch(); return void (f.caret = 0); }
        if (ev.ctrl && k === 'e') { touch(); return void (f.caret = f.value.length); }
        if (!ev.ctrl && !ev.meta && ev.ch && ev.ch >= ' ') {
          if (f.pristine) { f.value = ''; f.caret = 0; touch(); }
          f.value = f.value.slice(0, f.caret) + ev.ch + f.value.slice(f.caret);
          f.caret += ev.ch.length;
        }
      },

      onMouse(ev) {
        if (!ev.pressed || ev.wheel) return;
        const introRows = intro ? intro.length + 1 : 0;
        const idx = Math.floor((ev.y - BODY_TOP - introRows) / ROWS_PER_FIELD);
        if (idx >= 0 && idx < state.length) focus = idx;
      },
    };

    return this._run(view);
  }

  /* ─── dialog: confirm / cancel ─────────────────────────── */

  /**
   * A centred modal with real buttons. Destructive actions start focused on
   * Cancel, so a reflexive Enter never rewrites anyone's history.
   */
  dialog({ title, crumb, lines, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
    let focus = danger ? 0 : 1; // 0 = cancel, 1 = confirm
    let hit = null;             // where the buttons landed in the last frame

    const view = {
      frame(screen) {
        const W = screen.width;
        const boxW = Math.min(78, W - 6);
        const accent = danger ? theme.danger : theme.accent;
        const body = [''];

        body.push('  ' + accent(G.tl + G.h.repeat(boxW) + G.tr));
        for (const line of lines) {
          body.push('  ' + accent(G.v) + ' ' + fit(line, boxW - 2) + ' ' + accent(G.v));
        }
        body.push('  ' + accent(G.v) + ' ' + ' '.repeat(boxW - 2) + ' ' + accent(G.v));

        const cancelTxt = ` ${cancelLabel} `;
        const okTxt = ` ${confirmLabel} `;
        const cancel = focus === 0 ? chalk.bgWhite.black.bold(cancelTxt) : theme.dim(cancelTxt);
        const ok = focus === 1
          ? (danger ? chalk.bgRed.white.bold(okTxt) : chalk.bgGreen.black.bold(okTxt))
          : theme.dim(okTxt);

        const gap = Math.max(0, boxW - 2 - stringWidth(cancelTxt) - stringWidth(okTxt) - 3);
        // Columns are 1-based and the row starts with two spaces + border + space.
        const cancelX = 5 + gap;
        hit = {
          row: BODY_TOP + 1 + lines.length + 2,
          cancel: [cancelX, cancelX + stringWidth(cancelTxt) - 1],
          ok: [cancelX + stringWidth(cancelTxt) + 3, cancelX + stringWidth(cancelTxt) + 2 + stringWidth(okTxt)],
        };

        body.push('  ' + accent(G.v) + ' ' + ' '.repeat(gap) + cancel + '   ' + ok + ' ' + accent(G.v));
        body.push('  ' + accent(G.bl + G.h.repeat(boxW) + G.br));

        return chrome(screen, {
          title, crumb, body,
          help: keyHints([['←→', 'switch'], ['enter', 'activate'], ['y / n', 'shortcut'], ['esc', 'cancel']]),
        });
      },

      onKey(ev, api) {
        const k = ev.name;
        if (k === 'left' || k === 'h')       focus = 0;
        else if (k === 'right' || k === 'l') focus = 1;
        else if (k === 'tab')                focus = focus === 0 ? 1 : 0;
        else if (ev.ch === 'y')              api.done(true);
        else if (ev.ch === 'n' || k === 'escape' || ev.ch === 'q') api.done(false);
        else if (k === 'return')             api.done(focus === 1);
      },

      onMouse(ev, api) {
        if (!ev.pressed || ev.wheel || !hit || ev.y !== hit.row) return;
        if (ev.x >= hit.ok[0] && ev.x <= hit.ok[1])         api.done(true);
        else if (ev.x >= hit.cancel[0] && ev.x <= hit.cancel[1]) api.done(false);
      },
    };

    return this._run(view);
  }

  /** A scrollable read-only page with one button — reports, previews, errors. */
  page({ title, crumb, right, lines, buttonLabel = 'OK', help }) {
    let offset = 0;

    const view = {
      frame(screen) {
        const room = Math.max(3, screen.height - 9);
        const total = lines.length;
        offset = Math.max(0, Math.min(offset, Math.max(0, total - room)));
        const body = lines.slice(offset, offset + room).map((l) => ' ' + l);
        while (body.length < room) body.push('');
        body.push('');
        body.push('  ' + chalk.bgWhite.black.bold(` ${buttonLabel} `)
          + (total > room
            ? theme.dim(`   ${offset + 1}–${Math.min(offset + room, total)} of ${total}`)
            : ''));
        return chrome(screen, {
          title, crumb, right, body,
          help: help || keyHints([['enter', 'continue'], ['↑↓', 'scroll'], ['esc', 'back']]),
        });
      },
      onKey(ev, api) {
        const k = ev.name;
        if (k === 'up' || k === 'k')        offset = Math.max(0, offset - 1);
        else if (k === 'down' || k === 'j') offset += 1;
        else if (k === 'pageup')            offset = Math.max(0, offset - 10);
        else if (k === 'pagedown')          offset += 10;
        else if (k === 'return' || ev.ch === ' ') api.done(true);
        else if (k === 'escape' || ev.ch === 'q') api.done(false);
      },
      onMouse(ev) {
        if (ev.wheel === 'up')   offset = Math.max(0, offset - 3);
        if (ev.wheel === 'down') offset += 3;
      },
    };

    return this._run(view);
  }

  /** Run an arbitrary custom view (the file browser) on this session's screen. */
  custom(view) {
    return this._run(view);
  }
}

module.exports = { Ui, BODY_TOP, reflow, twoCol };
