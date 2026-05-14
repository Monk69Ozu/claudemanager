#!/usr/bin/env node

'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // Patterns that trigger token rotation — matched against ANSI-stripped output
  triggerPatterns: [
    /quota exceeded/i,
    /limit reached/i,
    /rate limit/i,
    /too many requests/i,
    /\b429\b/,
    /context window/i,
    /usage limit/i,
    /credit balance/i,
    /credits? exhausted/i,
  ],

  // Injected via stdin before shutdown so the CLI persists its state
  saveStateCommand: [
    'Aktualisiere jetzt zwingend die Datei STATE.md. Dokumentiere kurz und präzise:\n',
    '\n',
    'Aktueller Status: Was haben wir gerade konkret erreicht?\n',
    '\n',
    'Zuletzt bearbeitete Dateien: Liste exakt die Dateien auf, die für den nächsten Schritt wichtig sind.\n',
    '\n',
    'Offene Bugs/Probleme: Was klemmt gerade noch?\n',
    '\n',
    'Nächster exakter Schritt: Was genau muss als Nächstes programmiert werden?\n',
    '\n',
    "Führe danach sofort die nötigen Git-Befehle aus, um alle Änderungen inklusive der STATE.md zu committen und in das Projekt-Repo zu pushen. Nutze als Commit-Nachricht: 'chore: status update for handover'\n",
  ].join(''),

  // Injected via stdin after restart to resume from saved state.
  // Replace the placeholder with your actual GitHub repository URL before use.
  resumeCommand: [
    'Hier ist das Projekt-Repository: [HIER NUR DEN GITHUB LINK EINFÜGEN]\n',
    '\n',
    'Klone oder öffne dieses Repo lokal. Lies danach als allererstes AUSSCHLIESSLICH die Datei STATE.md.\n',
    '\n',
    "Lese anschließend NUR die Dateien ein, die in der STATE.md unter 'Zuletzt bearbeitete Dateien' aufgeführt sind. Scanne auf keinen Fall das restliche Projektverzeichnis!\n",
    '\n',
    "Fasse mir in einem kurzen Satz zusammen, was das Ziel ist, und beginne dann sofort mit der Umsetzung des Punkts 'Nächster exakter Schritt' aus der STATE.md.\n",
  ].join(''),

  // ms to wait for the CLI to handle saveStateCommand before escalating to SIGTERM
  gracefulShutdownTimeout: 15_000,

  // ms to wait after spawn before injecting resumeCommand
  // (lets the CLI print its initial prompt)
  resumeDelay: 3_000,

  cliCommand: process.env.CLI_COMMAND || 'claude',

  // Always pass --dangerously-skip-permissions to suppress interactive
  // confirmation prompts that would otherwise block automated runs.
  cliBaseArgs: ['--dangerously-skip-permissions'],
};

// ---------------------------------------------------------------------------
// .env loader (no external dependencies)
// ---------------------------------------------------------------------------

function loadEnv(envPath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}`);
  }
  const tokens = [];
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key   = t.slice(0, eq).trim();
    const value = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    const m = key.match(/^SESSION_TOKEN_(\d+)$/);
    if (m) tokens[parseInt(m[1], 10) - 1] = value;
  }
  const out = tokens.filter(Boolean);
  if (!out.length) throw new Error('No SESSION_TOKEN_* entries found in .env');
  return out;
}

// ---------------------------------------------------------------------------
// Logger — always writes to stderr so child stdout stays uncontaminated
// ---------------------------------------------------------------------------

const ts  = () => new Date().toISOString();
const log = {
  info:  (m) => process.stderr.write(`[${ts()}] [SM:INFO]  ${m}\n`),
  warn:  (m) => process.stderr.write(`[${ts()}] [SM:WARN]  ${m}\n`),
  error: (m) => process.stderr.write(`[${ts()}] [SM:ERROR] ${m}\n`),
  debug: (m) => process.env.DEBUG && process.stderr.write(`[${ts()}] [SM:DEBUG] ${m}\n`),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip ANSI escape sequences so trigger regexes match plain text.
// Applied only to the sniff buffer — the raw chunk is still passed through.
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b[()][AB012]|\x1b[=>]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

// Write data to a writable stream; resolves true once the OS has accepted it.
// Handles backpressure via the drain event.
function writeToStdin(stream, data) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || !stream.writable) {
      resolve(false);
      return;
    }
    log.debug(`stdin ← ${JSON.stringify(data.trim())}`);
    const flushed = stream.write(data, 'utf8', (err) => {
      if (err) reject(err); else resolve(true);
    });
    if (!flushed) stream.once('drain', () => resolve(true));
  });
}

// Detect stdbuf (coreutils) for forcing unbuffered output on pipe-connected
// child processes. Node.js buffers stdout/stderr when not connected to a TTY.
function hasStdbuf() {
  try { execSync('stdbuf --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const USE_STDBUF = hasStdbuf();

// ---------------------------------------------------------------------------
// SniffBuffer — accumulates output chunks, fires a callback per complete line
// ---------------------------------------------------------------------------

class SniffBuffer {
  constructor(onLine) {
    this._buf  = '';
    this._cb   = onLine;
  }

  push(chunk) {
    this._buf += stripAnsi(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const lines = this._buf.split('\n');
    this._buf   = lines.pop() ?? '';         // keep the incomplete trailing fragment
    for (const line of lines) this._cb(line);
  }

  flush() {
    if (this._buf) { this._cb(this._buf); this._buf = ''; }
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

class SessionManager {
  constructor(tokens) {
    this.tokens         = tokens;
    this.tokenIndex     = 0;
    this.process        = null;
    this.isRotating     = false;
    this.isShuttingDown = false;
    this.rotationCount  = 0;

    // The active stdin→child forwarder function; stored so it can be removed
    this._stdinHandler  = null;
  }

  get currentToken() { return this.tokens[this.tokenIndex]; }

  // ── Environment ──────────────────────────────────────────────────────────

  buildEnv() {
    const env = { ...process.env };
    // Inject the rotating key; always override — never inherit from parent shell
    env.ANTHROPIC_API_KEY = this.currentToken;
    // Remove any alternative key name that could shadow ANTHROPIC_API_KEY
    delete env.CLAUDE_API_KEY;
    return env;
  }

  buildArgv() {
    const extra = process.env.CLI_EXTRA_ARGS
      ? process.env.CLI_EXTRA_ARGS.split(' ').filter(Boolean)
      : [];
    const args = [...CONFIG.cliBaseArgs, ...extra];
    if (USE_STDBUF) {
      return { cmd: 'stdbuf', args: ['-o0', '-e0', CONFIG.cliCommand, ...args] };
    }
    return { cmd: CONFIG.cliCommand, args };
  }

  // ── Trigger detection ─────────────────────────────────────────────────────

  isTrigger(line) {
    return CONFIG.triggerPatterns.some((re) => re.test(line));
  }

  // ── stdin passthrough ─────────────────────────────────────────────────────

  // Forward every keystroke / chunk from the host terminal to the child.
  // Using a data listener (rather than .pipe()) makes it trivial to detach.
  attachStdinPassthrough(child) {
    // Enable raw mode when running in a real terminal so keystrokes are
    // forwarded immediately without waiting for Enter.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      log.debug('stdin raw mode enabled');
    }
    process.stdin.resume();

    this._stdinHandler = (chunk) => {
      // In raw mode Ctrl-C arrives as ETX (\x03) — handle graceful shutdown.
      // Without this the signal never reaches the manager.
      if (process.stdin.isRaw && (chunk[0] === 0x03 || chunk === '')) {
        log.info('Ctrl-C received — shutting down');
        this.stop().then(() => process.exit(0));
        return;
      }
      // Ctrl-D (EOT, \x04) — forward EOF to child
      if (process.stdin.isRaw && (chunk[0] === 0x04 || chunk === '')) {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        return;
      }
      if (child.stdin && child.stdin.writable) {
        child.stdin.write(chunk);
      }
    };

    process.stdin.on('data', this._stdinHandler);
    log.debug('stdin passthrough attached');
  }

  // Stop forwarding user input — called as the very first step of shutdown
  // so no stray keystrokes can race with the injected save-state command.
  detachStdinPassthrough() {
    if (!this._stdinHandler) return;
    process.stdin.removeListener('data', this._stdinHandler);
    this._stdinHandler = null;

    // Restore cooked mode so the terminal is usable if we exit without restart
    if (process.stdin.isTTY && process.stdin.isRaw) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    log.debug('stdin passthrough detached');
  }

  // ── Output passthrough + sniffing ─────────────────────────────────────────

  // Wire up stdout and stderr.
  //
  // For each stream:
  //   1. Write the raw chunk to the host terminal immediately (transparent).
  //   2. Push the chunk into a SniffBuffer that strips ANSI and fires a
  //      callback per complete line — trigger detection happens there.
  //
  // The two steps are independent; step 1 never blocks on step 2.
  attachOutputPassthrough(child) {
    const stdoutSniffer = new SniffBuffer((line) => {
      log.debug(`stdout sniff: ${line}`);
      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger on stdout: "${line.trim()}"`);
        this.handleRotation();
      }
    });

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);          // 1. transparent passthrough
      stdoutSniffer.push(chunk);            // 2. non-destructive sniff
    });
    child.stdout.on('end', () => stdoutSniffer.flush());

    const stderrSniffer = new SniffBuffer((line) => {
      log.debug(`stderr sniff: ${line}`);
      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger on stderr: "${line.trim()}"`);
        this.handleRotation();
      }
    });

    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);          // 1. transparent passthrough
      stderrSniffer.push(chunk);            // 2. non-destructive sniff
    });
    child.stderr.on('end', () => stderrSniffer.flush());
  }

  // ── Process lifecycle ─────────────────────────────────────────────────────

  spawnProcess() {
    const { cmd, args } = this.buildArgv();
    const env = this.buildEnv();

    log.info(
      `Spawning: ${cmd} ${args.join(' ')} ` +
      `[slot ${this.tokenIndex + 1}/${this.tokens.length}, ` +
      `key=…${this.currentToken.slice(-6)}]`
    );

    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.attachOutputPassthrough(child);

    child.on('error', (err) => {
      log.error(`Spawn error: ${err.message}`);
      if (!this.isRotating && !this.isShuttingDown) {
        setTimeout(() => this.handleRotation(), 2_000);
      }
    });

    child.on('close', (code, signal) => {
      log.info(`Process closed — code=${code} signal=${signal}`);
      if (!this.isRotating && !this.isShuttingDown) {
        log.warn('Unexpected exit — triggering rotation');
        this.process = null;
        this.handleRotation();
      }
    });

    this.process = child;
    return child;
  }

  // Graceful shutdown sequence:
  //   1. Detach user stdin immediately (no racing input)
  //   2. Inject save-state command and wait for kernel acknowledgement
  //   3. Close stdin so the CLI sees EOF after the command
  //   4. Wait up to gracefulShutdownTimeout for a clean exit
  //   5. Escalate: SIGTERM → 2 s → SIGKILL
  async gracefulShutdown() {
    if (!this.process) return;

    // Step 1: block user input before touching stdin
    this.detachStdinPassthrough();

    log.info('Sending save-state command …');
    const sent = await writeToStdin(this.process.stdin, CONFIG.saveStateCommand)
      .catch((e) => { log.warn(`stdin write failed: ${e.message}`); return false; });
    log.info(sent ? 'Save-state command delivered' : 'Save-state command not delivered (stdin gone)');

    if (this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }

    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => {
        log.warn(`Shutdown timeout (${CONFIG.gracefulShutdownTimeout}ms) — escalating`);
        resolve(false);
      }, CONFIG.gracefulShutdownTimeout);
      this.process.once('close', () => { clearTimeout(t); resolve(true); });
    });

    if (!exited && this.process && !this.process.killed) {
      log.info('Sending SIGTERM …');
      this.process.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 2_000));
      if (this.process && !this.process.killed) {
        log.warn('Still alive — sending SIGKILL');
        this.process.kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.process = null;
    log.info('Process terminated');
  }

  rotateToken() {
    const prev = this.tokenIndex;
    this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length;
    this.rotationCount++;
    if (this.tokenIndex === 0) log.warn('All slots exhausted — cycling back to slot 1');
    log.info(`Token rotated: slot ${prev + 1} → ${this.tokenIndex + 1} (rotation #${this.rotationCount})`);
  }

  // Full handover cycle:
  //   shutdown → rotate → spawn → wait for ready → resume → re-attach stdin
  async handleRotation() {
    if (this.isRotating) {
      log.debug('Rotation already in progress — duplicate trigger ignored');
      return;
    }
    this.isRotating = true;
    try {
      await this.gracefulShutdown();          // saves state, kills old process
      this.rotateToken();                     // advance to next token slot
      const child = this.spawnProcess();      // start fresh with new key

      log.info(`Waiting ${CONFIG.resumeDelay}ms for CLI to initialise …`);
      await new Promise((r) => setTimeout(r, CONFIG.resumeDelay));

      // Inject resume command BEFORE re-attaching user stdin so there is no
      // interleaving between the injected command and user keystrokes.
      const sent = await writeToStdin(child.stdin, CONFIG.resumeCommand);
      log.info(sent ? 'Resume command injected' : 'Resume command skipped (stdin not ready)');

      this.attachStdinPassthrough(child);     // restore interactive passthrough
    } catch (err) {
      log.error(`Rotation failed: ${err.stack}`);
    } finally {
      this.isRotating = false;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async start() {
    log.info(`Session Manager starting — ${this.tokens.length} token(s) loaded`);
    log.info(USE_STDBUF ? 'stdbuf active — output unbuffered' : 'stdbuf not found — output may be buffered');

    const child = this.spawnProcess();

    log.info(`Waiting ${CONFIG.resumeDelay}ms for initial CLI startup …`);
    await new Promise((r) => setTimeout(r, CONFIG.resumeDelay));

    const sent = await writeToStdin(child.stdin, CONFIG.resumeCommand);
    log.info(sent ? 'Initial resume command sent' : 'Initial resume command skipped');

    this.attachStdinPassthrough(child);
  }

  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.info('Session Manager shutting down …');
    await this.gracefulShutdown();
    log.info('Session Manager stopped');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  let tokens;
  try {
    tokens = loadEnv();
    log.info(`Loaded ${tokens.length} session token(s) from .env`);
  } catch (err) {
    log.error(err.message);
    process.exit(1);
  }

  // Restore terminal state on any exit path so the shell stays usable
  process.on('exit', () => {
    try {
      if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
    } catch { /* best-effort */ }
  });

  const manager = new SessionManager(tokens);

  const shutdown = async (sig) => {
    log.info(`Received ${sig}`);
    await manager.stop();
    process.exit(0);
  };

  // SIGINT is only relevant in non-TTY / non-raw-mode scenarios;
  // in raw mode Ctrl-C is intercepted in the stdin handler above.
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException',  (e) => log.error(`Uncaught: ${e.stack}`));
  process.on('unhandledRejection', (r) => log.error(`Unhandled rejection: ${r}`));

  await manager.start();
}

main();
