"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { portableCwd } = require("./pathing");

function runJsonCommand(command, value, defaultCwd, options = {}) {
  const argv = command.argv.slice();
  const timeoutMs = command.timeoutMs || 2000;
  const argvBaseDir = options.argvBaseDir || commandCwd(command, defaultCwd);
  const resolvedArgv = resolveArgv(argv, argvBaseDir);
  const tempCwd = options.cleanTempCwd ? fs.mkdtempSync(path.join(os.tmpdir(), "backpath-reverse-")) : null;
  const cwd = tempCwd || options.cwdOverride || commandCwd(command, defaultCwd);
  const input = JSON.stringify(value);
  const started = process.hrtime.bigint();

  const result = spawnSync(resolvedArgv[0], resolvedArgv.slice(1), {
    input,
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    env: command.env ? { ...process.env, ...command.env } : process.env,
    shell: false,
    windowsHide: true
  });

  let cleanupError = null;
  if (tempCwd) {
    try {
      fs.rmSync(tempCwd, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error.message;
    }
  }

  const durationMs = elapsedMs(started);
  const evidence = {
    argv,
    cwd,
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    spawned: !(result.error && result.error.code !== "ETIMEDOUT"),
    durationMs,
    timeout: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    timeoutMs,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    output: undefined,
    malformedOutput: false,
    executionError: null,
    stage: options.stage,
    isolation: options.isolation || null,
    cleanupError,
    envMode: command.env ? "inherit-plus-declared" : "inherit",
    declaredEnv: command.env ? { ...command.env } : {},
    portableContext: options.portableContext || null
  };
  evidence.killed = evidence.timeout || evidence.signal !== null;

  if (result.error && result.error.code !== "ETIMEDOUT") {
    evidence.executionError = result.error.message;
    return commandRun(evidence);
  }

  if (evidence.timeout) {
    return commandRun(evidence);
  }

  if (evidence.exitCode !== 0) {
    return commandRun(evidence);
  }

  try {
    evidence.output = JSON.parse(evidence.stdout);
  } catch (_error) {
    evidence.malformedOutput = true;
  }

  return commandRun(evidence);
}

function commandRun(evidence) {
  return {
    ...evidence,
    succeeded:
      evidence.exitCode === 0 &&
      !evidence.timeout &&
      !evidence.malformedOutput &&
      !evidence.executionError,
    toEvidence() {
      const data = {
        argv: evidence.argv,
        timeoutMs: evidence.timeoutMs || 2000,
        cwd: evidence.cwd,
        exitCode: evidence.exitCode,
        durationMs: evidence.durationMs,
        timeout: evidence.timeout,
        stderr: evidence.stderr
      };
      if (evidence.signal) {
        data.signal = evidence.signal;
      }
      if (!evidence.spawned) {
        data.spawned = false;
      }
      if (evidence.killed) {
        data.killed = true;
      }
      if (evidence.stage) {
        data.stage = evidence.stage;
      }
      if (evidence.portableContext) {
        Object.assign(data, portableCwd(evidence.cwd, evidence.portableContext));
      }
      if (evidence.isolation) {
        data.isolation = evidence.isolation;
      }
      data.environment = {
        mode: evidence.envMode || "inherit",
        declared: evidence.declaredEnv || {}
      };
      if (evidence.malformedOutput) {
        data.malformedOutput = true;
        data.stdout = evidence.stdout;
      }
      if (evidence.executionError) {
        data.executionError = evidence.executionError;
      }
      if (evidence.cleanupError) {
        data.cleanupError = evidence.cleanupError;
      }
      return data;
    }
  };
}

function commandCwd(command, defaultCwd) {
  if (!command.cwd) {
    return defaultCwd;
  }
  return path.isAbsolute(command.cwd) ? command.cwd : path.resolve(defaultCwd, command.cwd);
}

function elapsedMs(started) {
  return Math.max(0, Number((process.hrtime.bigint() - started) / 1000000n));
}

function resolveArgv(argv, baseDir) {
  return argv.map((item, index) => {
    if (index === 0 || path.isAbsolute(item) || item.startsWith("-")) {
      return item;
    }
    const candidate = path.resolve(baseDir, item);
    if (looksPathLike(item) || fs.existsSync(candidate)) {
      return fs.existsSync(candidate) ? candidate : item;
    }
    return item;
  });
}

function looksPathLike(value) {
  return value.startsWith(".") || value.includes("/") || value.includes("\\");
}

module.exports = {
  runJsonCommand
};
