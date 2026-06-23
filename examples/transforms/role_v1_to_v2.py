#!/usr/bin/env python3
import json, sys
x = json.load(sys.stdin)
role = x.get("role")
print(json.dumps({"name": x.get("name"), "role": "member" if role is None else role}))
