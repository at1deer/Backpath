#!/usr/bin/env python3
import json, sys
x = json.load(sys.stdin)
print(json.dumps(x))
