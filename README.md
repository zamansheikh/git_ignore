# git-vanish 🔥

![git-vanish](./git-vanish.png)

> Interactively browse your repo and **permanently vanish a sensitive file from all git commit history** — without deleting your other commits.

## The problem

You `git push`ed a file containing secrets (API keys, passwords, `.env`, `credentials.json`, etc.) to GitHub. Once it's in history, just deleting the file and committing again is **not enough** — the secret is still visible in every past commit.

`git-vanish` surgically removes that file from **every single commit** across all branches and tags, while preserving the rest of your history exactly as it was.

---

## Install globally

```bash
npm install -g git-vanish
```

---

## Usage

Run inside any git repository:

```bash
git-vanish
```

This opens an **interactive terminal file browser** where you can navigate your repo and pick the file to scrub.

### Options

| Flag                | Description                                   |
| ------------------- | --------------------------------------------- |
| `-r, --repo <path>` | Path to git repo (default: current directory) |
| `-f, --file <path>` | Skip browser — provide the file path directly |
| `--dry-run`         | Preview what would happen, no changes made    |
| `--no-gc`           | Skip the aggressive garbage collection step   |
| `-V, --version`     | Show version                                  |
| `-h, --help`        | Show help                                     |

---

## Redaction mode — when the secret is *inside* a file you need to keep

Vanishing a whole file is right for something that should never have been tracked
(`.env`, `credentials.json`). It's the wrong move when the leak is a hardcoded
password or token inside a real source file: removing the file would delete that
source from every historical commit.

Redaction mode rewrites the **content** instead. Every occurrence of the secret
across all commits, branches and tags becomes a placeholder, and the files stay
exactly where they are, still tracked.

```bash
# one or more secrets, repeatable
git-vanish --secret "hunter2" --secret "my-db-password"

# preview first — always do this
git-vanish --secret "hunter2" --dry-run

# read them from a file instead, so they never touch your shell history
git-vanish --secrets-file ./leaked-secrets.txt
```

| Flag                    | Description                                                |
| ----------------------- | ---------------------------------------------------------- |
| `-s, --secret <text>`   | Literal string to redact from all history (repeatable)     |
| `--secrets-file <path>` | One secret per line; `#` comments and blank lines ignored  |
| `--replacement <text>`  | Substituted text (default `***REMOVED***`)                 |

Notes:

- Requires **git-filter-repo** (`brew install git-filter-repo` / `pip install git-filter-repo`).
  `filter-branch` can't do this safely — it would need a tree-filter rewriting
  every blob on every commit.
- The working tree must be clean; history rewriting touches every commit.
- Secrets are **masked** in all terminal output, and the temp replacement list is
  deleted afterwards.
- After the rewrite, git-vanish re-checks every secret and **fails loudly** if any
  occurrence survived.
- `git-filter-repo` removes your `origin` remote on purpose. Re-add it and force-push:

  ```bash
  git remote add origin <url>
  git push --force --all && git push --force --tags
  ```

⚠️ **Redaction is not a substitute for rotating the secret.** Anyone who cloned
before the rewrite still has it, and hosts like GitHub can keep old commits
reachable by SHA until they garbage-collect. Rotate first, redact second.

### Examples

```bash
# Interactive file browser
git-vanish

# Vanish a specific file directly
git-vanish --file config/secrets.json

# Preview only (no changes)
git-vanish --dry-run

# Different repo
git-vanish --repo /path/to/my-project
```

---

## Keyboard Controls (file browser)

| Key               | Action                                   |
| ----------------- | ---------------------------------------- |
| `↑` / `↓`         | Navigate up/down                         |
| `→` / `Enter`     | Open directory or quick-select file      |
| `←` / `Backspace` | Go up one directory                      |
| `j` / `k`         | Vim-style up/down                        |
| `Space`           | Toggle file selection (multi-select)     |
| `a`               | Select all tracked files in current view |
| `u`               | Deselect all                             |
| `/`               | Search/filter entries                    |
| `Escape`          | Clear search                             |
| `Page Up/Down`    | Jump one page                            |
| `Home` / `End`    | Jump to first/last                       |
| `q`               | Quit without selecting                   |

---

## What it does (step by step)

1. **Finds your git repo root** (walks up from cwd)
2. **Loads all git-tracked files** — both current and historic
3. **Opens TUI browser** — navigate directories, see only tracked files highlighted
4. **Shows every commit** that ever contained the file
5. **Confirms** with a warning before changing anything
6. **Rewrites history** using `git filter-repo` (if installed) or `git filter-branch` (built into git) — removes the file from every commit
7. **Cleans up** reflogs and runs `git gc --aggressive --prune=now`
8. **Adds the file to `.gitignore`** so it can never be committed again
9. **Prints force-push commands** to update your remote

---

## After running

You **must** force-push to update the remote:

```bash
git push origin --force --all
git push origin --force --tags
```

Then **rotate any leaked secrets immediately** (GitHub and other platforms may cache content in their CDN even after a rewrite).

All collaborators must re-clone or run:

```bash
git fetch --all
git reset --hard origin/<branch>
```

---

## Speed tip — `git filter-repo`

`git-vanish` automatically prefers [`git-filter-repo`](https://github.com/newren/git-filter-repo) if it's installed — it's ~10-50× faster than `filter-branch` on large repos.

```bash
pip install git-filter-repo
# or
brew install git-filter-repo
```

---

## How history rewriting works

```
Before scrub:
  commit A  – adds secret.json ← 🔒 secret visible here
  commit B  – other changes
  commit C  – other changes
  commit D  – deletes secret.json
  commit E  – other changes   ← HEAD (secret STILL in history)

After scrub:
  commit A' – (secret.json never existed)
  commit B' – other changes   (identical diff, different hash)
  commit C' – other changes
  commit D' – (empty commit pruned if nothing else changed)
  commit E' – other changes   ← HEAD (clean history)
```

All other files, diffs, messages, authors, and timestamps are preserved exactly.

---

## Requirements

- Node.js ≥ 14
- Git ≥ 2.x (must be in PATH)

---

## License

MIT
