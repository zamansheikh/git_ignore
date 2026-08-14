'use strict';

/**
 * File picker.
 *
 * Two ways to find a file, because people look for files in two different
 * ways. Browse mode walks the directory tree the way a file manager does.
 * Search mode (press `s`) ignores the tree entirely and fuzzy-matches against
 * every path git has ever tracked — which is how you actually find `.env` in a
 * repo you don't know by heart.
 *
 * Selection is a checkbox list with a live tray of what you have picked, so
 * "what am I about to destroy" is never more than a glance away.
 */

const fs = require('fs');
const path = require('path');
const chalk = require('chalk');

const { theme, G, fit, keyHints, chrome, scrollbar } = require('./tui');
const { BODY_TOP, reflow, twoCol } = require('./ui');

const TRAY_ROWS = 4;

/** Human-readable file size, or '' for anything we couldn't stat. */
function humanSize(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Subsequence match, so "senv" finds "src/.env". Returns a score, or -1. */
function fuzzyScore(haystack, needle) {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) return 1000 - direct;      // contiguous wins outright

  let score = 0;
  let at = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, at);
    if (found < 0) return -1;
    score += found === at ? 3 : 1;
    at = found + 1;
  }
  return score;
}

class FileBrowser {
  /**
   * @param {object} o
   * @param {string}   o.root      repo root
   * @param {string[]} o.gitFiles  every path git has tracked (null = unknown)
   */
  constructor(o = {}) {
    this.root = o.root || process.cwd();
    this.gitFiles = o.gitFiles || null;
    this.trackedSet = new Set(this.gitFiles || []);
    this.title = o.title || 'Select file(s) to vanish from history';
    this.crumb = o.crumb || 'Vanish files';

    this.cwd = this.root;
    this.mode = 'browse';        // 'browse' | 'search'
    this.query = '';
    this.filter = '';
    this.filtering = false;
    this.cursor = 0;
    this.offset = 0;
    this.selected = new Set();   // repo-relative paths
    this.flash = null;

    this._load();
  }

  /* ─── data ─────────────────────────────────────────────── */

  _load() {
    let names;
    try { names = fs.readdirSync(this.cwd); } catch { names = []; }

    const dirs = [];
    const files = [];

    for (const name of names) {
      if (name === '.git') continue;
      const full = path.join(this.cwd, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }

      const rel = path.relative(this.root, full).replace(/\\/g, '/');
      if (stat.isDirectory()) {
        dirs.push({ name, full, rel, isDir: true });
      } else {
        files.push({
          name, full, rel,
          isDir: false,
          size: stat.size,
          tracked: this.gitFiles ? this.trackedSet.has(rel) : true,
        });
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));

    this.entries = this.cwd === this.root
      ? [...dirs, ...files]
      : [{ name: '..', full: path.dirname(this.cwd), isDir: true, isUp: true }, ...dirs, ...files];

    // Skip past ".." so opening a folder lands on its contents. Going back up
    // is one ← away and does not need the cursor parked on it.
    this.cursor = this.entries.length > 1 && this.entries[0].isUp ? 1 : 0;
    this.offset = 0;
  }

  /** Rows currently on screen, for whichever mode we are in. */
  _rows() {
    if (this.mode === 'search') {
      const pool = this.gitFiles || [];
      const scored = [];
      for (const rel of pool) {
        const score = fuzzyScore(rel, this.query);
        if (score >= 0) scored.push({ rel, score });
      }
      scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
      return scored.slice(0, 500).map(({ rel }) => ({
        name: rel,
        rel,
        isDir: false,
        tracked: true,
        full: path.join(this.root, rel),
        fromSearch: true,
      }));
    }

    if (!this.filter) return this.entries;
    const q = this.filter.toLowerCase();
    return this.entries.filter((e) => e.isUp || e.name.toLowerCase().includes(q));
  }

  /* ─── rendering ────────────────────────────────────────── */

  frame(screen) {
    const W = screen.width;
    const rows = this._rows();
    const height = Math.max(3, screen.height - 8 - TRAY_ROWS);
    this.offset = reflow(this.cursor, rows.length, height, this.offset);
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, rows.length - 1)));

    const bar = scrollbar(rows.length, height, this.offset);
    const inner = W - 6;
    const body = [];

    if (rows.length === 0) {
      body.push('');
      body.push('   ' + theme.dim(this.mode === 'search'
        ? 'No tracked file matches that search.'
        : 'Nothing here.'));
      for (let i = 2; i < height; i++) body.push('');
    } else {
      rows.slice(this.offset, this.offset + height).forEach((e, i) => {
        const idx = i + this.offset;
        const active = idx === this.cursor;
        const chosen = !e.isDir && this.selected.has(e.rel);

        let icon;
        let label;
        let detail = '';

        if (e.isUp) {
          icon = '↩ ';
          label = '..';
          detail = 'parent folder';
        } else if (e.isDir) {
          icon = '📁';
          label = e.name + '/';
        } else {
          icon = e.tracked ? '📄' : '🔒';
          label = e.name;
          detail = e.tracked
            ? (e.fromSearch ? 'tracked' : humanSize(e.size))
            : 'not tracked';
        }

        const box = e.isDir ? '   ' : (chosen ? `[${G.check}]` : '[ ]');
        const row = twoCol(`${icon} ${label}`, detail, inner - 4);

        let painted;
        if (active)          painted = theme.selected(row);
        else if (chosen)     painted = theme.chosen(row);
        else if (e.isDir)    painted = theme.warn(row);
        else if (!e.tracked) painted = theme.dim(row);
        else                 painted = chalk.white(row);

        const marker = active ? theme.accent(G.cursor) : ' ';
        const check = chosen ? theme.chosen(box) : theme.dim(box);
        body.push(` ${marker} ${check} ${painted}${bar[i] || ''}`);
      });
    }

    // ── selection tray ──
    body.push(' ' + theme.rule('─'.repeat(Math.max(0, W - 2))));
    const picks = [...this.selected];
    if (picks.length === 0) {
      body.push(' ' + theme.dim(' Nothing selected — Space ticks a file, Enter takes the one under the cursor.'));
      body.push('');
    } else {
      const chips = picks.slice(0, 3).map((p) => theme.chosen.inverse(` ${path.basename(p)} `)).join(' ');
      const more = picks.length > 3 ? theme.dim(`  +${picks.length - 3} more`) : '';
      body.push(' ' + theme.ok(` ${picks.length} file(s) queued: `) + chips + more);
      body.push(' ' + theme.dim(' ' + fit(picks.join('  ·  '), W - 4)));
    }

    // ── search / filter line ──
    if (this.mode === 'search') {
      body.push(' ' + theme.accent.inverse(' SEARCH ') + ' '
        + chalk.white(this.query) + chalk.inverse(' ')
        + theme.dim(`   ${rows.length} match(es) across all tracked files`));
    } else if (this.filtering) {
      body.push(' ' + theme.warn.inverse(' FILTER ') + ' '
        + chalk.white(this.filter) + chalk.inverse(' ')
        + theme.dim('   Enter to keep, Esc to clear'));
    } else if (this.flash) {
      body.push(' ' + this.flash);
    } else {
      body.push('');
    }

    const where = this.mode === 'search'
      ? theme.accent('searching all tracked files')
      : theme.dim('📂 ' + (path.relative(this.root, this.cwd) || '.'));

    const help = this.mode === 'search'
      ? keyHints([['type', 'to search'], ['space', 'tick'], ['enter', 'go'], ['esc', 'browse']])
      : this.filtering
        ? keyHints([['type', 'to filter'], ['enter', 'keep'], ['esc', 'clear']])
        : keyHints([
            ['↑↓', 'move'], ['→', 'open'], ['←', 'up'], ['space', 'tick'],
            ['s', 'search all'], ['enter', 'continue'], ['esc', 'quit'],
          ]);

    return chrome(screen, {
      title: this.title,
      crumb: this.crumb,
      right: path.basename(this.root),
      status: where,
      body,
      help,
    });
  }

  /* ─── input ────────────────────────────────────────────── */

  onKey(ev, api) {
    this.flash = null;
    const rows = this._rows();
    const entry = rows[this.cursor];
    const k = ev.name;

    // Text-entry modes swallow printable keys.
    if (this.mode === 'search' || this.filtering) {
      if (k === 'escape') {
        if (this.mode === 'search') { this.mode = 'browse'; this.query = ''; this._load(); }
        else { this.filtering = false; this.filter = ''; this.cursor = 0; }
        return;
      }
      if (k === 'backspace') {
        if (this.mode === 'search') this.query = this.query.slice(0, -1);
        else this.filter = this.filter.slice(0, -1);
        this.cursor = 0;
        return;
      }
      if (k === 'return' && this.filtering) { this.filtering = false; return; }
      if (!ev.ctrl && !ev.meta && ev.ch && ev.ch >= ' ' && k !== 'return') {
        if (this.mode === 'search') this.query += ev.ch;
        else this.filter += ev.ch;
        this.cursor = 0;
        return;
      }
      // Everything else (arrows, Enter in search mode) falls through to
      // navigation, so you can type and move without leaving the search.
    }

    if (k === 'up' || (k === 'k' && this.mode === 'browse' && !this.filtering))
      this.cursor = Math.max(0, this.cursor - 1);
    else if (k === 'down' || (k === 'j' && this.mode === 'browse' && !this.filtering))
      this.cursor = Math.min(rows.length - 1, this.cursor + 1);
    else if (k === 'pageup')   this.cursor = Math.max(0, this.cursor - 10);
    else if (k === 'pagedown') this.cursor = Math.min(rows.length - 1, this.cursor + 10);
    else if (k === 'home')     this.cursor = 0;
    else if (k === 'end')      this.cursor = rows.length - 1;

    else if (k === 'left' || k === 'backspace') {
      if (this.mode === 'browse' && this.cwd !== this.root) {
        const leaving = this.cwd;
        this.cwd = path.dirname(this.cwd);
        this._load();
        // Land on the folder we just came out of, not at the top.
        const back = this._rows().findIndex((e) => e.full === leaving);
        if (back >= 0) this.cursor = back;
      }
    }

    else if (ev.ch === ' ') this._toggle(entry, rows);

    else if (k === 'right') {
      if (entry && entry.isDir) { this.cwd = entry.full; this._load(); }
      else this._toggle(entry, rows);
    }

    else if (k === 'return') {
      if (entry && entry.isDir) { this.cwd = entry.full; this._load(); return; }
      // Enter is the fast path: take what is under the cursor and go.
      if (entry && !entry.isDir) {
        if (!this._selectable(entry)) return;
        this.selected.add(entry.rel);
      }
      if (this.selected.size > 0) return api.done([...this.selected]);
      this.flash = theme.warn('Nothing selected yet.');
    }

    else if (this.mode === 'browse' && !this.filtering) {
      if (ev.ch === 's') { this.mode = 'search'; this.query = ''; this.cursor = 0; this.offset = 0; }
      else if (ev.ch === '/') { this.filtering = true; this.filter = ''; this.cursor = 0; }
      else if (ev.ch === 'a') {
        for (const e of rows) if (!e.isDir && e.tracked) this.selected.add(e.rel);
      } else if (ev.ch === 'n' || ev.ch === 'u') this.selected.clear();
      else if (k === 'escape' || ev.ch === 'q') api.done(null);
    }
  }

  onMouse(ev, api) {
    const rows = this._rows();
    if (ev.wheel === 'up')   return void (this.cursor = Math.max(0, this.cursor - 3));
    if (ev.wheel === 'down') return void (this.cursor = Math.min(rows.length - 1, this.cursor + 3));
    if (!ev.pressed) return;

    const idx = ev.y - BODY_TOP + this.offset;
    if (idx < 0 || idx >= rows.length) return;
    const entry = rows[idx];
    this.cursor = idx;

    // Clicking a folder opens it; clicking a file ticks it. Matches the
    // single-click habits of a file dialog.
    if (entry.isDir) {
      this.cwd = entry.full;
      this._load();
    } else {
      this._toggle(entry, rows);
    }
  }

  _selectable(entry) {
    if (!entry || entry.isDir) return false;
    if (this.gitFiles && !entry.tracked) {
      this.flash = theme.danger(`${G.cursor} "${entry.name}" is not tracked by git — there is nothing in history to remove.`);
      return false;
    }
    return true;
  }

  _toggle(entry, rows) {
    if (!this._selectable(entry)) return;
    if (this.selected.has(entry.rel)) this.selected.delete(entry.rel);
    else this.selected.add(entry.rel);
    this.cursor = Math.min(rows.length - 1, this.cursor + 1);
  }
}

module.exports = FileBrowser;
