#!/usr/bin/env python3
import json, sys
x = json.load(sys.stdin)
approval = x.get("approval")
if approval in ("manual", "automatic"):
    print(json.dumps({"approved": True}))
elif approval == "rejected":
    print(json.dumps({"approved": False}))
else:
    print(f"unsupported approval: {approval}", file=sys.stderr)
    sys.exit(12)
