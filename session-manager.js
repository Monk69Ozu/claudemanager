#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // Patterns that trigger a token rotation
  triggerPatterns: [
    /quota exceeded/i,
    /limit reached/i,
    /rate limit/i,
    /too many requests/i,
    /429/,
    /context window/i,
    /usage limit/i,
  ],

  // Command sent to the CLI before shutdown so it can persist state
  saveStateCommand: 'Aktualisiere die STATE.md mit dem aktuellen Fortschritt und speichere ab.\n',

  // Command sent after restart so the CLI can resume
  resumeCommand: 'Lies die STATE.md und setze die Arbeit exakt dort fort.\n',

  // How long (ms) to wait after sending the save-state command before killing
  gracefulShutdownTimeout: 15_000,

  // How long (ms) to wait before sending the resume command after startup
  resumeDelay: 3_000,

  // CLI command + args to launch (override via env CLI_COMMAND / CLI_ARGS)
  cliCommand: process.env.CLI_COMMAND || 'claude',
  cliArgs: process.env.CLI_ARGS ? process.env.CLI_ARGS.split(' ') : [],
};

// ---------------------------------------------------------------------------
// Env loading (minimal, no external dependencies)
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

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');

    // Collect SESSION_TOKEN_1 … SESSION_TOKEN_N in order
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

function ts() {
  return new Date().toISOString();
}

const log = {
  info:  (msg) => console.log (`[${ts()}] [INFO]  ${msg}`),
  warn:  (msg) => console.warn(`[${ts()}] [WARN]  ${msg}`),
  error: (msg) => console.error(`[${ts()}] [ERROR] ${msg}`),
  debug: (msg) => process.env.DEBUG && console.log(`[${ts()}] [DEBUG] ${msg}`),
};

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

class SessionManager {
  constructor(tokens) {
    this.tokens = tokens;
    this.tokenIndex = 0;
    this.process = null;
    this.isRotating = false;
    this.isShuttingDown = false;
    this.rotationCount = 0;
  }

  get currentToken() {
    return this.tokens[this.tokenIndex];
  }

  // Send a line of text to the child process stdin
  sendCommand(command) {
    if (!this.process || this.process.stdin.destroyed) {
      log.warn('Cannot send command — stdin not available');
      return false;
    }
    log.info(`Sending command: ${command.trim()}`);
    this.process.stdin.write(command);
    return true;
  }

  // Check output line against all trigger patterns
  isTrigger(line) {
    return CONFIG.triggerPatterns.some((re) => re.test(line));
  }

  // Gracefully ask the CLI to save state, then kill the process
  async gracefulShutdown() {
    if (!this.process) return;

    log.info('Initiating graceful shutdown — requesting state save …');
    this.sendCommand(CONFIG.saveStateCommand);

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        log.warn('Graceful shutdown timeout reached — forcing kill');
        resolve();
      }, CONFIG.gracefulShutdownTimeout);

      this.process.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      // Give the process a chance to exit on its own first
      this.process.stdin.end();
    });

    if (this.process && !this.process.killed) {
      log.info('Sending SIGTERM …');
      this.process.kill('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 2_000));

      if (this.process && !this.process.killed) {
        log.warn('Process still alive after SIGTERM — sending SIGKILL');
        this.process.kill('SIGKILL');
      }
    }

    this.process = null;
  }

  // Rotate to the next token (wraps around)
  rotateToken() {
    const previous = this.tokenIndex;
    this.tokenIndex = (this.tokenIndex + 1) % this.tokens.length;
    this.rotationCount += 1;
    log.info(
      `Token rotated: slot ${previous + 1} → slot ${this.tokenIndex + 1} ` +
      `(rotation #${this.rotationCount}, ${this.tokens.length} tokens total)`
    );

    if (this.tokenIndex === 0) {
      log.warn('All tokens exhausted — cycling back to slot 1');
    }
  }

  // Start the CLI process with the current token
  startProcess() {
    const env = {
      ...process.env,
      ANTHROPIC_API_KEY: this.currentToken,
      // Some CLIs also read these names
      CLAUDE_API_KEY: this.currentToken,
    };

    log.info(
      `Starting CLI (slot ${this.tokenIndex + 1}/${this.tokens.length}): ` +
      `${CONFIG.cliCommand} ${CONFIG.cliArgs.join(' ')}`
    );

    const child = spawn(CONFIG.cliCommand, CONFIG.cliArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Stream stdout to our console and watch for triggers
    const stdoutRL = readline.createInterface({ input: child.stdout });
    stdoutRL.on('line', (line) => {
      process.stdout.write(`[CLI] ${line}\n`);
      log.debug(`stdout: ${line}`);

      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger detected: "${line}"`);
        this.handleRotation();
      }
    });

    // Stream stderr
    const stderrRL = readline.createInterface({ input: child.stderr });
    stderrRL.on('line', (line) => {
      process.stderr.write(`[CLI:ERR] ${line}\n`);

      if (!this.isRotating && this.isTrigger(line)) {
        log.warn(`Trigger detected in stderr: "${line}"`);
        this.handleRotation();
      }
    });

    child.on('error', (err) => {
      log.error(`Failed to spawn process: ${err.message}`);
      if (!this.isRotating && !this.isShuttingDown) {
        log.info('Attempting restart after spawn error …');
        setTimeout(() => this.handleRotation(), 2_000);
      }
    });

    child.on('close', (code, signal) => {
      log.info(`Process exited — code=${code} signal=${signal}`);
      if (!this.isRotating && !this.isShuttingDown) {
        log.warn('Unexpected exit — rotating token and restarting');
        this.process = null;
        this.handleRotation();
      }
    });

    this.process = child;
    return child;
  }

  // Orchestrate: save state → rotate → restart → resume
  async handleRotation() {
    if (this.isRotating) {
      log.debug('Rotation already in progress — skipping duplicate trigger');
      return;
    }
    this.isRotating = true;

    try {
      await this.gracefulShutdown();
      this.rotateToken();
      this.startProcess();

      log.info(`Waiting ${CONFIG.resumeDelay}ms before sending resume command …`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.resumeDelay));

      this.sendCommand(CONFIG.resumeCommand);
    } catch (err) {
      log.error(`Error during rotation: ${err.message}`);
    } finally {
      this.isRotating = false;
    }
  }

  // Entry point
  async start() {
    log.info(`Session Manager starting — ${this.tokens.length} tokens loaded`);
    this.startProcess();

    log.info(`Waiting ${CONFIG.resumeDelay}ms before sending initial resume command …`);
    await new Promise((resolve) => setTimeout(resolve, CONFIG.resumeDelay));
    this.sendCommand(CONFIG.resumeCommand);
  }

  // Clean stop (called on SIGINT / SIGTERM)
  async stop() {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;
    log.info('Session Manager shutting down …');
    await this.gracefulShutdown();
    log.info('Session Manager stopped');
  }
}

// ---------------------------------------------------------------------------
// Main
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

  // Graceful shutdown on Ctrl-C or SIGTERM
  const shutdown = async (signal) => {
    log.info(`Received ${signal}`);
    await manager.stop();
    process.exit(0);
  };

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Unhandled errors — log and attempt to keep running
  process.on('uncaughtException', (err) => {
    log.error(`Uncaught exception: ${err.stack}`);
  });
  process.on('unhandledRejection', (reason) => {
    log.error(`Unhandled rejection: ${reason}`);
  });

  await manager.start();
}

main();
