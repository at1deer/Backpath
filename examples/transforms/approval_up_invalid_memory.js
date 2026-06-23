#!/usr/bin/env node
"use strict";

process.stdout.write(`${JSON.stringify({
  target: { approved: true },
  memory: { approvalMode: 123 }
})}\n`);
