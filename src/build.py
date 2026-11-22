#!/usr/bin/env python3
"""Build index.html (repo root) from the sources in src/. Standard library only.
Usage: python3 src/build.py
"""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(here, *a)
read = lambda p: open(P(p), encoding="utf-8").read()
b64 = lambda p: base64.b64encode(open(P(p), "rb").read()).decode()
t = read("template.html")
t = t.replace("{{STYLE}}", read("style.css").strip("\n"))
t = t.replace("{{LOGO}}", read("logo/header-inline.svg"))
t = t.replace("{{TAIL}}", read("tail_scripts.html").rstrip())
t = t.replace("{{FONT600}}", b64("appcond-600.woff")).replace("{{FONT700}}", b64("appcond-700.woff"))
t = t.replace("{{FAVICON}}", b64("favicon-64.png")).replace("{{LOGIC}}", read("logic.js").rstrip())
assert "{{" not in t, t[t.index("{{"):t.index("{{") + 40]
open(os.path.join(here, "..", "index.html"), "w", encoding="utf-8").write(t)
print("index.html", len(t))
