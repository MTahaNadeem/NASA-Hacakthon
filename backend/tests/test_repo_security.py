"""The frontend and the repository must not contain NASA credentials."""
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
SKIP_DIRS = {".git", "node_modules", "__pycache__", "fixtures", ".pytest_cache"}
PATTERNS = [re.compile(p, re.I) for p in (
    r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.",      # a JWT, which is what Earthdata bearer tokens are
    r"EARTHDATA_(TOKEN|PASS|PASSWORD)\s*=\s*['\"][^'\"\s]{6,}['\"]",
    r"Authorization['\"]?\s*[:=]\s*['\"]Bearer\s+[A-Za-z0-9._-]{20,}",
)]


def _files(root, exts):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in files:
            if f.endswith(exts):
                yield os.path.join(d, f)


def test_no_credentials_in_frontend_or_backend_source():
    bad = []
    for root in ("app", "backend/app", "pipeline"):
        for path in _files(os.path.join(REPO, root), (".js", ".html", ".json", ".py", ".md")):
            text = open(path, encoding="utf-8", errors="ignore").read()
            for pat in PATTERNS:
                if pat.search(text):
                    bad.append(path)
    assert bad == []


def test_frontend_never_reads_earthdata_variables():
    for path in _files(os.path.join(REPO, "app"), (".js", ".html")):
        text = open(path, encoding="utf-8", errors="ignore").read()
        assert "EARTHDATA" not in text.upper().replace("EARTHDATA LOGIN", ""), path
