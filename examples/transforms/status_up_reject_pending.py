#!/usr/bin/env python3
import json, sys
x = json.load(sys.stdin)
status = x.get("status")
if status == "active":
    print(json.dumps({"state": "enabled"}))
elif status == "suspended":
    print(json.dumps({"state": "disabled"}))
elif status == "closed":
    print(json.dumps({"state": "archived"}))
elif status == "pending_review":
    print("unsupported status: pending_review", file=sys.stderr)
    sys.exit(12)
else:
    print(f"unknown status: {status}", file=sys.stderr)
    sys.exit(12)
