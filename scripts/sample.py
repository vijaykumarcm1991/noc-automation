#!/usr/bin/env python3
"""Sample automation script.

Reads secrets injected as environment variables by the automation tool and
prints them (a demo only — don't log real secrets in production scripts).
"""
import os

print("Hello from the automation tool's sample Python script!")
name = os.environ.get("GREETING_NAME", "world")
print(f"Hello, {name}!")

# Demonstrate a resolved secret: env var name matches the secret "name".
api_key = os.environ.get("API_KEY")
if api_key:
    print(f"Resolved secret API_KEY has {len(api_key)} characters (value not printed).")

print("Done.")
