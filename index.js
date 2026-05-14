#!/usr/bin/env node

'use strict';

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // Trigger patterns that initiate token rotation
  triggerPatterns: [
    /quota exceeded/i,
    /limit reached/i,
    /rate limit/i,
    /too many requests/i,
    /\b429\b/,
    /context window/i,
    /usage limit/i,
    /credits? exhausted/i,
    /billing/i,
  ],

  // Sent to the CLI via stdin before shutdown — must end with \n
  saveStateCommand: 'Aktualisiere die STATE.md mit dem aktuellen Fortschritt und speichere ab.\n',

  // Sent via stdin immediately after the new process is ready
  resumeCommand: 'Lies die STATE.md und setze die Arbeit exakt dort fort.\n',

  // ms to wait for the CLI to handle the save-state command before hard-killing
  gracefulShutdownTimeout: 15_000,

  // ms after process start before sending the resume command
  // (gives the CLI time to initialise and print its prompt)
  resumeDelay: 3_000,

  // The Claude Code CLI binary name
  cliCommand: process.env.CLI_COMMAND || 'claude',

  // --dangerously-skip-permissions suppresses all interactive confirmation
  // prompts so automated runs never block waiting for user input.
  // Additional flags can be appended via CLI_EXTRA_ARGS env var.
  cliBaseArgs: ['--dangerously-skip-permissions'],
};

// ---------------------------------------------------------------------------
// Minimal .env parser (no external dependencies)
// ---------------------------------------------------------------------------

function loadEnv(envPath = path.join(__dirname, '.env')) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env file not found at ${envPath}`);
  }

  const raw = fs.readFileSync(envPath, 'utf8');
  const tokens = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key   = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');

    const match = key.match(/^SESSION_TOKEN_(\d+)$/);
    if (match) {
      tokens[parseInt(match[1], 10) - 1] = value;
    }
  }

  const filtered = tokens.filter(Boolean);
  if (filtered.length === 0) {
    throw new Error('No SESSION_TOKEN_* entries found in .env');
  }

  return filtered;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const ts  = () => new Date().toISOString();
const log = {
  info:  (msg) => console.log (`[${ts()}] [INFO]  ${msg}`),
  warn:  (msg) => console.warn(`[${ts()}] [WARN]  ${msg}`),
  error: (msg) => console.error(`[${ts()}] [ERROR] ${msg}`),
  debug: (msg) => process.env.DEBUG && console.log(`[${ts()}] [DEBUG] ${msg}`),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Write data to a writable stream and resolve once the kernel has accepted it.
// Returns false immediately if the stream is not writable.
function writeToStdin(stream, data) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.destroyed || !stream.writable) {
      resolve(false);
      return;
    }
    log.debug(`stdin ← ${data.trim()}`);
    const ok = stream.write(data, 'utf8', (err) => {
      if (err) reject(err);
      else     resolve(true);
    });
    if (!ok) {
      // Backpressure: wait for drain before resolving
      stream.once('drain', () => resolve(true));
    }
  });
}

// Detect whether stdbuf is available (Linux util to force unbuffered output).
// When the child process is a Node.js app that checks isTTY it may buffer
// stdout/stderr when connected to a pipe; stdbuf forces line-buffered output.
function hasStdbuf() {
  try { execSync('stdbuf --version', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

const USE_STDBUF = hasStdbuf();

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

class SessionManager {
  constructor(tokens) {
    this.tokens       = tokens;
    this.tokenIndex   = 0;
    this.process      = null;
    this.isRotating   = false;
    this.isShuttingDown = false;
    this.rotationCount  = 0;
  }

  get currentToken() { return this.tokens[this.tokenIndex]; }

  // Build the environment for the child process.
  // We deliberately override ANTHROPIC_API_KEY each time so the rotating
  // token is always the one in effect — never the parent shell's value.
  buildEnv() {
    const env = { ...process.env };

    // Inject current rotating token
    env.ANTHROPIC_API_KEY = this.currentToken;

    // Disable ANSI escape codes so trigger regexes match plain text
    env.NO_COLOR    = '1';
    env.FORCE_COLOR = '0';
    env.TERM        = 'dumb';

    // Remove any stale key that might shadow ANTHROPIC_API_KEY
    delete env.CLAUDE_API_KEY;

    return env;
  }

  // Build final argv, optionally prepending stdbuf to prevent output buffering
  buildArgv() {
    const extraArgs = process.env.CLI_EXTRA_ARGS
      ? process.env.CLI_EXTRA_ARGS.split(' ').filter(Boolean)
      : [];
    const args = [...CONFIG.cliBaseArgs, ...extraArgs];

    if (USE_STDBUF) {
      // -o0 unbuffered stdout, -e0 unbuffered stderr
      return { cmd: 'stdbuf', args: ['-o0', '-e0', CONFIG.cliCommand, ...args] };
    }
    return { cmd: CONFIG.cliCommand, args };
  }

  // Check whether a line of output should trigger rotation
  isTrigger(line) {
    return CONFIG.triggerPatterns.some((re) => re.test(line));
  }

  // Attach readline interfaces to stdout/stderr of the child process.
  // Mirrors output to our console and watches every line for trigger patterns.
  attachIO(child) {
    const stdoutRL = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    stdoutRL.on('line', (line) => {
      process.stdout.write(`[CLI] ${line}\n`);
      log.debug(`stdout: ${line}`);
      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger detected on stdout: "${line}"`);
        this.handleRotation();
      }
    });
    stdoutRL.on('close', () => log.debug('stdout stream closed'));

    const stderrRL = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrRL.on('line', (line) => {
      process.stderr.write(`[CLI:ERR] ${line}\n`);
      log.debug(`stderr: ${line}`);
      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger detected on stderr: "${line}"`);
        this.handleRotation();
      }
    });
    stderrRL.on('close', () => log.debug('stderr stream closed'));
  }

  // Send the save-state command via stdin, wait for it to be accepted by the
  // kernel, then close stdin and wait for the process to exit gracefully.
  // Falls back to SIGTERM → SIGKILL if the process doesn't exit in time.
  async gracefulShutdown() {
    if (!this.process) return;

    log.info('Graceful shutdown: sending save-state command via stdin …');

    // Step 1: write the handover command and wait for kernel acknowledgement
    const sent = await writeToStdin(
      this.process.stdin,
      CONFIG.saveStateCommand
    ).catch((err) => {
      log.warn(`stdin write error: ${err.message}`);
      return false;
    });

    if (sent) {
      log.info('Save-state command delivered to stdin');
    } else {
      log.warn('Could not deliver save-state command — stdin unavailable');
    }

    // Step 2: signal end-of-input so the CLI knows no more commands are coming
    if (this.process.stdin && !this.process.stdin.destroyed) {
      this.process.stdin.end();
    }

    // Step 3: wait for the process to exit on its own (up to gracefulShutdownTimeout)
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn(`Graceful shutdown timeout (${CONFIG.gracefulShutdownTimeout}ms) — escalating`);
        resolve(false);
      }, CONFIG.gracefulShutdownTimeout);

      this.process.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    if (!exited && this.process && !this.process.killed) {
      log.info('Sending SIGTERM …');
      this.process.kill('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      if (this.process && !this.process.killed) {
        log.warn('Still alive after SIGTERM — sending SIGKILL');
        this.process.kill('SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    this.process = null;
    log.info('Process terminated');
  }

  // Advance to the next token slot (wraps around with a warning)
  rotateToken() {
    const prev = this.tokenIndex;
    this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length;
    this.rotationCount += 1;

    if (this.tokenIndex === 0) {
      log.warn('All token slots exhausted — cycling back to slot 1');
    }

    log.info(
      `Token rotated: slot ${prev + 1} → slot ${this.tokenIndex + 1} ` +
      `(rotation #${this.rotationCount})`
    );
  }

  // Spawn the CLI with the current token injected as ANTHROPIC_API_KEY
  startProcess() {
    const { cmd, args } = this.buildArgv();
    const env = this.buildEnv();

    log.info(
      `Spawning: ${cmd} ${args.join(' ')} ` +
      `[ANTHROPIC_API_KEY=...${this.currentToken.slice(-6)}, ` +
      `slot ${this.tokenIndex + 1}/${this.tokens.length}]`
    );

    const child = spawn(cmd, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.attachIO(child);

    child.on('error', (err) => {
      log.error(`Spawn error: ${err.message}`);
      if (!this.isRotating && !this.isShuttingDown) {
        log.info('Scheduling restart after spawn error …');
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

  // Full rotation cycle: save state → kill → rotate token → restart → resume
  async handleRotation() {
    if (this.isRotating) {
      log.debug('Rotation already in progress — ignoring duplicate trigger');
      return;
    }
    this.isRotating = true;

    try {
      await this.gracefulShutdown();
      this.rotateToken();
      this.startProcess();

      log.info(`Waiting ${CONFIG.resumeDelay}ms for CLI to initialise …`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.resumeDelay));

      const sent = await writeToStdin(this.process?.stdin, CONFIG.resumeCommand);
      if (sent) {
        log.info('Resume command sent');
      } else {
        log.warn('Could not send resume command — process may not be ready');
      }
    } catch (err) {
      log.error(`Rotation error: ${err.stack}`);
    } finally {
      this.isRotating = false;
    }
  }

  async start() {
    log.info(`Session Manager starting — ${this.tokens.length} token(s) loaded`);
    if (USE_STDBUF) {
      log.info('stdbuf detected — output buffering disabled');
    } else {
      log.warn('stdbuf not found — output may be buffered (install coreutils for best results)');
    }

    this.startProcess();

    log.info(`Waiting ${CONFIG.resumeDelay}ms for initial CLI startup …`);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.resumeDelay));

    const sent = await writeToStdin(this.process?.stdin, CONFIG.resumeCommand);
    log.info(sent ? 'Initial resume command sent' : 'Initial resume command skipped (stdin not ready)');
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

  const manager = new SessionManager(tokens);

  const shutdown = async (signal) => {
    log.info(`Received ${signal} — initiating shutdown`);
    await manager.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException',  (err)    => log.error(`Uncaught exception: ${err.stack}`));
  process.on('unhandledRejection', (reason) => log.error(`Unhandled rejection: ${reason}`));

  await manager.start();
}

main();
