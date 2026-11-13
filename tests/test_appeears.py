"""Offline test of appeears.py task bookkeeping with the network mocked."""
import json, sys, tempfile
from pathlib import Path
from unittest import mock
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pipeline"))
import appeears as ap

def run(tmp, post_ok=True):
    ap.STATE = Path(tmp) / "tasks.json"; calls = []
    def post(url, **kw):
        calls.append(url); r = mock.Mock(); r.ok = post_ok; r.status_code = 200 if post_ok else 403; r.text = "no"; r.json = lambda: {"task_id": "T%d" % len(calls)}; return r
    with mock.patch.object(ap, "token", lambda: {"Authorization": "Bearer x"}), mock.patch.object(ap.requests, "post", post):
        ap.cmd_submit()
    return calls

with tempfile.TemporaryDirectory() as t:
    assert len(run(t)) == len(ap.PRODUCTS)                     # first run submits every product
    saved = json.loads(ap.STATE.read_text()); assert all(v["ids"] == ap._ids() for v in saved.values())
    assert run(t) == []                                         # same places -> nothing resubmitted
    saved["modis_ndvi"]["ids"] = ["only_one_place"]; ap.STATE.write_text(json.dumps(saved))
    assert len(run(t)) == 1                                     # places changed -> only that product is resubmitted
    ap.STATE.write_text(json.dumps({"modis_ndvi": "legacy-string-id", "smap_rootzone": {"task_id": "S", "ids": ap._ids()}}))
    assert len(run(t)) == 1 and ap._tid("legacy-string-id") == "legacy-string-id"   # old tasks.json format is replaced, not crashed on
with tempfile.TemporaryDirectory() as t:
    assert len(run(t, post_ok=False)) == len(ap.PRODUCTS) and not ap.STATE.exists()  # failures are reported and never recorded as submitted
print("appeears tests passed")
