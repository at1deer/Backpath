#!/usr/bin/env python3
import json, sys
y = json.load(sys.stdin)
if y.get("approved") is True:
    print(json.dumps({"approval": "manual"}))
elif y.get("approved") is False:
    print(json.dumps({"approval": "rejected"}))
else:
    print("unsupported approved value", file=sys.stderr)
    sys.exit(12)
