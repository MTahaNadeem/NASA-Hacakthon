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


FRONTEND_FORBIDDEN = [re.compile(p, re.I) for p in (
    r"EARTHDATA_[A-Z]+",               # the env-var names used by the backend and pipeline
    r"urs\.earthdata\.nasa\.gov",       # the Earthdata Login host: a website must never talk to it
    r"['\"]Authorization['\"]",         # an auth header being set
    r"\bBearer\s",                      # a bearer token
    r"\bpassw(or)?d\b",                 # a password field or variable
)]


def test_frontend_never_handles_credentials():
    """The word 'Earthdata' may appear in explanations; credentials, login hosts and auth headers may not."""
    seen = 0
    for path in _files(os.path.join(REPO, "app"), (".js", ".html")):
        if os.sep + "vendor" + os.sep in path:
            continue       # third-party library, not our code
        seen += 1
        text = open(path, encoding="utf-8", errors="ignore").read()
        for pat in FRONTEND_FORBIDDEN:
            assert not pat.search(text), "%s matches %s" % (path, pat.pattern)
    assert seen > 10      # the scan really looked at the frontend


def test_the_frontend_test_really_catches_a_planted_credential(tmp_path):
    planted = 'fetch(url,{headers:{"Authorization":"Bearer abc"}}); var EARTHDATA_PASS="x";'
    assert sum(1 for pat in FRONTEND_FORBIDDEN if pat.search(planted)) >= 2
