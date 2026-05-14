# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the script

```bash
node index.js
```

No build step, no `npm install` — zero external dependencies. Node.js stdlib only.

On startup the script prompts interactively for a GitHub repo URL, then spawns the `claude` CLI. To skip the prompt in non-TTY environments, set `RESUME_REPO_URL` in the environment.

Enable verbose logging:
```bash
DEBUG=1 node index.js
```

## Configuration

All runtime configuration lives in `.env` (copy from `.env.example`):

| Key | Purpose |
|---|---|
| `SESSION_TOKEN_1` … `SESSION_TOKEN_N` | Anthropic API keys rotated in order; suffix must be consecutive from 1 |
| `CLI_COMMAND` | CLI binary to launch (default: `claude`) |
| `CLI_EXTRA_ARGS` | Space-separated extra flags appended to `--dangerously-skip-permissions` |
| `RESUME_REPO_URL` | Fallback repo URL used when stdin is not a TTY |

`loadEnv()` writes every `.env` key into `process.env`, so all variables are available to the manager at runtime without a wrapper shell.

## Architecture

Everything lives in `index.js`. There are no modules, no build pipeline, and no package.json.

### Startup sequence

```
loadEnv()  →  promptRepoUrl()  →  SessionManager.start()
                                       │
                                  spawnProcess()
                                  wait resumeDelay (3 s)
                                  writeToStdin(resumeCommand)
                                  attachStdinPassthrough()
```

### Token rotation cycle (triggered automatically)

```
trigger detected on stdout/stderr
        │
detachStdinPassthrough()          ← blocks user input immediately
writeToStdin(saveStateCommand)    ← CLI commits STATE.md and pushes
stdin.end()  →  wait for exit  →  SIGTERM  →  SIGKILL
        │
rotateToken()  →  spawnProcess()
wait resumeDelay (3 s)
writeToStdin(resumeCommand())     ← CLI reads STATE.md and resumes
attachStdinPassthrough()          ← user input restored
```

### Key classes and functions

**`SessionManager`** — owns the child process lifecycle.
- `spawnProcess()` — spawns with `stdio: ['pipe','pipe','pipe']`, calls `attachOutputPassthrough`
- `attachOutputPassthrough(child)` — wires `data` events: raw chunk → `process.stdout/stderr` (transparent), then into a `SniffBuffer` for trigger detection
- `attachStdinPassthrough(child)` — sets raw mode on TTY, forwards every chunk to `child.stdin` via a named handler stored in `this._stdinHandler`
- `detachStdinPassthrough()` — removes the handler, restores cooked mode, pauses stdin
- `gracefulShutdown()` — detach → saveStateCommand → `stdin.end()` → wait → SIGTERM → SIGKILL
- `handleRotation()` — full handover cycle; guarded by `this.isRotating` to prevent re-entrancy

**`SniffBuffer`** — line-accumulator used for trigger detection without touching the forwarded stream. Strips ANSI escape codes before matching.

**`writeToStdin(stream, data)`** — Promise-based write with backpressure handling (`drain` event fallback). Resolves `false` instead of throwing when the stream is gone.

**`promptRepoUrl()`** — opens a `readline.Interface`, asks once, then calls `rl.close()` which removes readline's stdin listeners and restores cooked mode before the proxy takes over. Ctrl-C during the prompt exits cleanly.

### stdout vs stderr

Manager log lines (`[SM:INFO]`, `[SM:WARN]`, etc.) always go to `process.stderr`. Child stdout goes to `process.stdout` and child stderr to `process.stderr` — both raw and unmodified so the user's terminal renders the CLI output exactly as-is.

### Trigger patterns

Defined in `CONFIG.triggerPatterns` (array of regexes). Matched against ANSI-stripped lines from both stdout and stderr. Adding a new pattern requires no structural change.

### Handover payloads

`CONFIG.saveStateCommand` — static multiline string injected before shutdown; instructs the CLI to write `STATE.md` and push with commit message `chore: status update for handover`.

`CONFIG.resumeCommand()` — function (not a string) that embeds `repoUrl` at call-time; instructs the restarted CLI to read only `STATE.md` and the files listed in it, then continue from "Nächster exakter Schritt".

### stdbuf detection

At module load time, `hasStdbuf()` checks for `stdbuf` (Linux coreutils). If present, every `spawnProcess()` call wraps the command as `stdbuf -o0 -e0 claude …` to force unbuffered output over the pipe. This does not affect Node.js-internal buffering but helps any native code the CLI may invoke.
