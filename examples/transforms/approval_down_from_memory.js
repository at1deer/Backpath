#!/usr/bin/env node
"use strict";

const envelope = JSON.parse(require("node:fs").readFileSync(0, "utf8"));

if (!envelope || !envelope.target || !envelope.memory) {
  process.stderr.write("reverse requires target and memory envelope\n");
  process.exitCode = 12;
} else if (envelope.memory.approvalMode === "unknown") {
  process.stdout.write(`${JSON.stringify({ approval: "manual" })}\n`);
} else {
  process.stdout.write(`${JSON.stringify({ approval: envelope.memory.approvalMode })}\n`);
}
