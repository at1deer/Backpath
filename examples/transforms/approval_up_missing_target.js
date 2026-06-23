#!/usr/bin/env node
"use strict";

process.stdout.write(`${JSON.stringify({
  memory: { approvalMode: "automatic" }
})}\n`);
