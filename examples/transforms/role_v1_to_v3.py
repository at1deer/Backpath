#!/usr/bin/env python3
import json, sys
x = json.load(sys.stdin)
out = {"name": x.get("name")}
if x.get("role") is not None:
    out["role"] = x.get("role")
print(json.dumps(out))
