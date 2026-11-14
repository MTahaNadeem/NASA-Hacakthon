import datetime as dt
import io

import h5py
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, main, service
from app.providers import harmony as hm


# ---- small in-memory files with the SAME structure as the real Harmony subsets inspected on 2026-11-14 ----
def imerg_file(lons, lats, grid):
    bio = io.BytesIO()
    with h5py.File(bio, "w") as f:
        f["lon"] = np.array(lons, "f4"); f["lat"] = np.array(lats, "f8"); f["precipitation"] = np.array(grid, "f4").reshape(1, len(lons), len(lats))
    return bio.getvalue()


def smap_file(lats, lons, vals):
    bio = io.BytesIO()
    with h5py.File(bio, "w") as f:
        g = f.create_group("Soil_Moisture_Retrieval_Data_AM")
        g["latitude"] = np.array(lats, "f4"); g["longitude"] = np.array(lons, "f4"); g["soil_moisture"] = np.array(vals, "f4")
    return bio.getvalue()


def opened(b):
    return h5py.File(io.BytesIO(b), "r")


def test_imerg_picks_the_nearest_cell_and_treats_fill_as_missing():
    b = imerg_file([74.35, 74.45], [31.55], [[1.94], [9.0]])            # two cells; the point is in the first
    with opened(b) as f:
        assert hm.parse_imerg(f, 31.55, 74.36) == 1.94
    b = imerg_file([74.35, 74.45], [31.55], [[-9999.9], [9.0]])         # nearest cell is empty: the neighbour's 9.0 must NOT be used
    with opened(b) as f:
        assert hm.parse_imerg(f, 31.55, 74.36) is None


def test_imerg_cell_too_far_from_the_point_is_not_used():
    with opened(imerg_file([80.0], [40.0], [[3.0]])) as f:
        assert hm.parse_imerg(f, 31.55, 74.35) is None


def test_smap_valid_range_fill_and_nearest_cell():
    lats = [[31.5, 31.5], [31.6, 31.6]]; lons = [[74.3, 74.4], [74.3, 74.4]]
    with opened(smap_file(lats, lons, [[0.20, 0.30], [0.25, 0.28]])) as f:
        assert hm.parse_smap(f, 31.5, 74.3) == 0.20
    with opened(smap_file(lats, lons, [[-9999.0, 0.30], [0.25, 0.28]])) as f:
        assert hm.parse_smap(f, 31.5, 74.3) is None                      # nearest cell has no reading; others are not borrowed
    with opened(smap_file(lats, lons, [[0.9, 0.30], [0.25, 0.28]])) as f:
        assert hm.parse_smap(f, 31.5, 74.3) is None                      # outside the file's valid 0.02-0.5 range


def test_dates_come_from_the_links_own_metadata():
    link = {"rel": "data", "title": "SMAP_L3_SM_P_E_20261109_R19240_001_Soil_Moisture_Retrieval_Data_AM_soil_moisture_subsetted.nc4",
            "temporal": {"start": "2026-11-09T00:00:00.000Z", "end": "2026-11-09T23:59:59.999Z"}}      # real link fields
    assert hm.link_date(link) == "2026-11-09" and hm.link_date({"rel": "data"}) is None
    assert hm.data_links({"links": [link, {"rel": "self"}]}) == [link]


# ---- the job flow with a fake Harmony ----
class Resp:
    def __init__(self, status=200, json=None, content=b"", headers=None):
        self.status_code, self._j, self.content, self.headers = status, json, content, headers or {}

    def json(self):
        return self._j


class FakeHarmony:
    def __init__(self, files, fail_download=(), job_status="successful", job_message=""):
        self.files, self.fail, self.status, self.msg, self.calls = files, set(fail_download), job_status, job_message, []

    def get(self, url, params=None, headers=None, follow_redirects=None):
        self.calls.append(url); assert headers["Authorization"] == "Bearer TESTTOKEN"
        if "/rangeset" in url:
            return Resp(303, headers={"location": "/jobs/abc-123"})
        if "/jobs/" in url:
            links = [{"rel": "data", "href": "https://h.example/f/%d" % i, "temporal": {"start": d + "T00:00:00.000Z"}} for i, (d, _) in enumerate(self.files)]
            return Resp(200, json={"status": self.status, "message": self.msg, "links": links, "errors": []})
        i = int(url.rsplit("/", 1)[-1])
        return Resp(500) if i in self.fail else Resp(200, content=self.files[i][1])

    def close(self):
        pass


def imerg_days():
    return [("2026-11-07", imerg_file([74.35], [31.55], [[0.0]])), ("2026-11-08", imerg_file([74.35], [31.55], [[4.28]])),
            ("2026-11-09", imerg_file([74.35], [31.55], [[-9999.9]])), ("2026-11-10", imerg_file([74.35], [31.55], [[1.94]]))]


def test_fetch_series_returns_sorted_days_with_gaps_as_none():
    rows = hm.fetch_series("imerg", 31.55, 74.35, "2026-11-07", "2026-11-10", token="TESTTOKEN", client=FakeHarmony(imerg_days()))
    assert rows == [("2026-11-07", 0.0), ("2026-11-08", 4.28), ("2026-11-09", None), ("2026-11-10", 1.94)]


def test_one_unreadable_file_does_not_hide_the_other_days():
    rows = dict(hm.fetch_series("imerg", 31.55, 74.35, "a", "b", token="TESTTOKEN", client=FakeHarmony(imerg_days(), fail_download=[1])))
    assert rows["2026-11-08"] is None and rows["2026-11-10"] == 1.94


def test_a_failed_job_is_an_error_with_a_helpful_hint_for_403():
    fake = FakeHarmony(imerg_days(), job_status="failed", job_message="WorkItem failed: 403 error retrieving")
    with pytest.raises(hm.HarmonyError, match="approve the GES DISC"):
        hm.fetch_series("imerg", 31.55, 74.35, "a", "b", token="TESTTOKEN", client=fake)


def test_no_token_is_an_error_not_a_guess(monkeypatch):
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "")
    with pytest.raises(hm.HarmonyError, match="no Earthdata token"):
        hm.fetch_series("imerg", 1, 1, "a", "b")


# ---- summaries ----
def test_imerg_summary():
    s = service.summarise_imerg([("2026-11-01", 25.0), ("2026-11-08", 4.0), ("2026-11-09", None), ("2026-11-10", 1.0)])
    assert s["total_mm"] == 30.0 and s["rainy_days"] == 3 and s["heavy_days"] == 1 and s["valid_days"] == 3 and s["days_listed"] == 4
    assert s["last7_mm"] == 5.0 and s["max_day"] == {"date": "2026-11-01", "mm": 25.0}


def test_smap_summary_counts_real_passes_only():
    s = service.summarise_smap([("2026-11-01", 0.20), ("2026-11-02", None), ("2026-11-04", 0.30)])
    assert s["valid_passes"] == 2 and s["days_listed"] == 3 and s["mean"] == 0.25 and s["latest"] == {"date": "2026-11-04", "value": 0.30}
    empty = service.summarise_smap([("2026-11-02", None)])
    assert empty["latest"] is None and empty["mean"] is None


# ---- service + API ----
@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.cache import Cache
    main._cache = Cache(str(tmp_path / "r.sqlite3")); main._limiter.per_minute = 1000; service._recent_jobs.clear()
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "SECRET-TEST-TOKEN")
    calls = []
    def fake_fetch(name, lat, lon, start, end, **kw):
        calls.append(name)
        if name == "imerg":
            return [("2026-11-09", 0.0), ("2026-11-10", 12.5)]
        return [("2026-11-08", None), ("2026-11-10", 0.21)]
    monkeypatch.setattr(hm, "fetch_series", fake_fetch)
    return TestClient(main.app), calls


def test_not_configured_without_a_token(api, monkeypatch):
    c, calls = api
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "")
    d = c.get("/api/recent?lat=31.55&lon=74.35").json()
    assert d["status"] == "not_configured" and calls == []


def test_recent_runs_in_the_background_then_serves_from_cache(api):
    import time
    c, calls = api
    first = c.get("/api/recent?lat=31.52&lon=74.31").json()
    assert first["status"] in ("running", "ready")
    for _ in range(50):
        d = c.get("/api/recent?lat=31.52&lon=74.31").json()
        if d["status"] == "ready":
            break
        time.sleep(0.1)
    assert d["status"] == "ready" and d["imerg"]["total_mm"] == 12.5 and d["smap"]["latest"]["value"] == 0.21
    n = len(calls)
    again = c.get("/api/recent?lat=31.54&lon=74.33").json()            # same 0.1 degree cell (31.5, 74.3): served from cache, no new Harmony jobs
    assert again["status"] == "ready" and again["served_from_cache"] is True and len(calls) == n


def test_requests_are_snapped_to_the_cell_centre_so_everyone_in_the_cell_gets_the_same_answer(api, monkeypatch):
    seen = []
    monkeypatch.setattr(hm, "fetch_series", lambda name, lat, lon, start, end, **kw: (seen.append((name, lat, lon)), [("2026-11-10", 1.0)])[1])
    a = service.recent(31.52, 74.31, main.get_cache(), background=False)
    assert {(la, lo) for _, la, lo in seen} == {(31.55, 74.35)} and a["cell"] == {"lat": 31.55, "lon": 74.35, "size_deg": 0.1}
    n = len(seen); b = service.recent(31.59, 74.39, main.get_cache(), background=False)       # other edge of the same cell
    assert b["status"] == "ready" and b["served_from_cache"] is True and len(seen) == n
    service.recent(31.61, 74.31, main.get_cache(), background=False)                            # next cell north: a new job
    assert len(seen) > n


def test_the_fast_product_is_shown_while_the_slow_one_is_still_running(api, monkeypatch):
    import threading, time
    c, _ = api
    release = threading.Event()
    def fetch(name, lat, lon, start, end, **kw):
        if name == "smap":
            release.wait(10)
        return [("2026-11-10", 2.5 if name == "imerg" else 0.2)]
    monkeypatch.setattr(hm, "fetch_series", fetch)
    c.get("/api/recent?lat=11.02&lon=11.02")
    for _ in range(60):
        d = c.get("/api/recent?lat=11.02&lon=11.02").json()
        if "imerg" in d:
            break
        time.sleep(0.05)
    assert d["status"] == "running" and d["imerg"]["total_mm"] == 2.5 and "smap" not in d      # rain is already there, soil moisture is not
    release.set()
    for _ in range(60):
        d = c.get("/api/recent?lat=11.02&lon=11.02").json()
        if d["status"] == "ready":
            break
        time.sleep(0.05)
    assert d["status"] == "ready" and d["smap"]["latest"]["value"] == 0.2 and d["imerg"]["total_mm"] == 2.5


def test_provenance_is_honest(api):
    c, _ = api
    d = service.recent(31.55, 74.35, main.get_cache(), background=False)
    for k in ("imerg", "smap"):
        p = d[k]["provenance"]
        assert p["kind"] == "satellite_estimate" and p["is_live"] is False and p["authentication_needed_by_farmer"] is False and p["data_through"]
    assert "Late run" in d["imerg"]["provenance"]["note"] and "preliminary" in d["imerg"]["provenance"]["note"]
    assert "not the root zone" in d["smap"]["provenance"]["note"]


def test_one_product_failing_keeps_the_other(api, monkeypatch):
    c, _ = api
    def fetch(name, lat, lon, start, end, **kw):
        if name == "smap":
            raise hm.HarmonyError("Harmony job failed: boom")
        return [("2026-11-10", 3.0)]
    monkeypatch.setattr(hm, "fetch_series", fetch)
    d = service.recent(10.0, 10.0, main.get_cache(), background=False)
    assert d["imerg"]["total_mm"] == 3.0 and "smap" not in d and "smap" in d["errors"] and any("SMAP could not be loaded" in g for g in d["gaps"])


def test_both_failing_is_an_error_never_invented_values(api, monkeypatch):
    c, _ = api
    monkeypatch.setattr(hm, "fetch_series", lambda *a, **k: (_ for _ in ()).throw(hm.HarmonyError("down")))
    d = service.recent(20.0, 20.0, main.get_cache(), background=False)
    assert d["status"] == "error" and "imerg" not in d and "smap" not in d


def test_the_token_never_appears_in_any_response(api):
    import time
    c, _ = api
    texts = [c.get("/api/health").text, c.get("/api/sources").text]
    c.get("/api/recent?lat=1&lon=1"); time.sleep(0.5)
    texts.append(c.get("/api/recent?lat=1&lon=1").text)
    assert all("SECRET-TEST-TOKEN" not in t for t in texts)


def test_input_validation(api):
    c, _ = api
    assert c.get("/api/recent?lat=95&lon=0").status_code == 422


def test_sources_say_recent_values_only_when_a_token_is_configured(api, monkeypatch):
    c, _ = api
    st = {x["id"]: x["status"] for x in c.get("/api/sources").json()["sources"]}
    assert st["smap"] == "recent_values" and st["imerg"] == "recent_values"
    monkeypatch.setattr(config, "EARTHDATA_TOKEN", "")
    st = {x["id"]: x["status"] for x in c.get("/api/sources").json()["sources"]}
    assert st["smap"] == "discovery_only" and st["imerg"] == "discovery_only"


def test_at_most_two_places_are_read_from_nasa_at_once(api, monkeypatch):
    import threading, time
    c, _ = api
    active, peak, lock, gate = [0], [0], threading.Lock(), threading.Event()
    def fetch(name, lat, lon, start, end, **kw):
        with lock:
            active[0] += 1; peak[0] = max(peak[0], active[0])
        gate.wait(5)
        with lock:
            active[0] -= 1
        return [("2026-11-10", 1.0)]
    monkeypatch.setattr(hm, "fetch_series", fetch)
    for i in range(5):
        c.get("/api/recent?lat=%d.05&lon=%d.05" % (40 + i, -90 - i))
    time.sleep(0.4); gate.set(); time.sleep(0.8)
    assert peak[0] <= 4          # 2 places x 2 products; without the cap five places would give 10


def test_soil_and_modis_jobs_share_the_same_ceiling_so_memory_stays_bounded(api, monkeypatch):
    """Four soil reads and two MODIS reads asked for at once: never more than HEAVY_JOBS at the same moment."""
    import threading, time
    from app.providers import soilgrids as sg, modis
    c, _ = api
    active, peak, lock, gate = [0], [0], threading.Lock(), threading.Event()
    def enter():
        with lock:
            active[0] += 1; peak[0] = max(peak[0], active[0])
        gate.wait(5)
        with lock:
            active[0] -= 1
    monkeypatch.setattr(sg, "fetch", lambda lat, lon: (enter(), {"soil": {"ph": {"q05": 6, "mean": 7, "q95": 8}}, "distance_km": 0, "pixel": [1, 2], "reason": None})[1])
    monkeypatch.setattr(modis, "search", lambda lat, lon, months, client=None: modis.parse_items(__import__("conftest").load("stac_modis13q1_lahore.json")))
    monkeypatch.setattr(modis, "series", lambda lat, lon, items, cache, max_workers=None: (enter(), [])[1])
    threads = [threading.Thread(target=lambda i=i: c.get("/api/soil?lat=%d.1&lon=%d.1" % (30 + i, 60 + i))) for i in range(4)]
    threads += [threading.Thread(target=lambda i=i: c.get("/api/ndvi?lat=%d.1&lon=%d.1" % (10 + i, 20 + i))) for i in range(2)]
    [t.start() for t in threads]; time.sleep(0.5); gate.set(); [t.join(10) for t in threads]
    assert 1 <= peak[0] <= service.HEAVY_JOBS
