"""Submit / check / download NASA AppEEARS point-sample jobs for MODIS NDVI and SMAP root-zone moisture.

Needs a free NASA Earthdata Login:  export EARTHDATA_USER=... EARTHDATA_PASS=...
  python pipeline/appeears.py products SPL4          # find real product names containing a word
  python pipeline/appeears.py layers MOD13Q1.061     # list layer names (verify before submitting!)
  python pipeline/appeears.py record modis_ndvi <task_id>   # save a task id submitted earlier
  python pipeline/appeears.py submit                 # one task per product, all locations as points
  python pipeline/appeears.py status                 # check queued tasks
  python pipeline/appeears.py download               # fetch finished CSVs into pipeline/raw/_appeears/

UNTESTED from the build sandbox (no network). Product/layer names below follow AppEEARS docs but
must be confirmed with the `layers` command; edit PRODUCTS if a name differs.
"""
import json, os, sys
from pathlib import Path
import requests

ROOT = Path(__file__).resolve().parent
CFG = json.loads((ROOT / "locations.json").read_text())
API = "https://appeears.earthdatacloud.nasa.gov/api"
STATE = ROOT / "raw" / "_appeears" / "tasks.json"
PRODUCTS = {
    "modis_ndvi": {"product": "MOD13Q1.061", "layer": "_250m_16_days_NDVI", "start": "01-01-%d", "end": "12-31-%d", "y0": None},
    # SMAP L4 starts in 2015, so its record is shorter than the 20-year climate record.
    "smap_rootzone": {"product": "SPL4SMGP.008", "layer": "Geophysical_Data_sm_rootzone", "y0": 2015},
}

def token():
    u, p = os.environ.get("EARTHDATA_USER"), os.environ.get("EARTHDATA_PASS")
    if not (u and p): sys.exit("Set EARTHDATA_USER and EARTHDATA_PASS")
    r = requests.post(f"{API}/login", auth=(u, p), timeout=60); r.raise_for_status()
    return {"Authorization": "Bearer " + r.json()["token"]}

def cmd_products(word):
    r = requests.get(f"{API}/product", timeout=60); r.raise_for_status()
    for p in r.json():
        if word.lower() in p["ProductAndVersion"].lower() or word.lower() in p.get("Description", "").lower():
            print(p["ProductAndVersion"], "|", p.get("Description", ""))

def cmd_record(name, task_id):
    tasks = json.loads(STATE.read_text()) if STATE.exists() else {}
    tasks[name] = task_id; STATE.parent.mkdir(parents=True, exist_ok=True); STATE.write_text(json.dumps(tasks, indent=1)); print("recorded", name, task_id)

def cmd_layers(product):
    r = requests.get(f"{API}/product/{product}", timeout=60); r.raise_for_status()
    print("\n".join(sorted(r.json().keys())))

def cmd_submit():
    h = token(); tasks = json.loads(STATE.read_text()) if STATE.exists() else {}
    y1 = CFG["period"]["end_year"]
    coords = [{"id": l["id"], "latitude": l["lat"], "longitude": l["lon"], "category": "field"} for l in CFG["locations"]]
    for name, p in PRODUCTS.items():
        if name in tasks: print("already submitted", name, tasks[name]); continue
        y0 = p.get("y0") or CFG["period"]["start_year"]
        body = {"task_type": "point", "task_name": f"rotation-explorer-{name}",
                "params": {"dates": [{"startDate": f"01-01-{y0}", "endDate": f"12-31-{y1}"}],
                           "layers": [{"product": p["product"], "layer": p["layer"]}],
                           "coordinates": coords}}
        r = requests.post(f"{API}/task", json=body, headers=h, timeout=120)
        if not r.ok: print("FAILED", name, r.status_code, r.text[:500]); continue
        tasks[name] = r.json()["task_id"]; print("submitted", name, tasks[name])
        STATE.parent.mkdir(parents=True, exist_ok=True); STATE.write_text(json.dumps(tasks, indent=1))

def cmd_status():
    h = token()
    for name, tid in json.loads(STATE.read_text()).items():
        r = requests.get(f"{API}/task/{tid}", headers=h, timeout=60); r.raise_for_status()
        print(name, tid, r.json().get("status"))

def cmd_download():
    h = token(); out = STATE.parent
    for name, tid in json.loads(STATE.read_text()).items():
        files = requests.get(f"{API}/bundle/{tid}", headers=h, timeout=60).json().get("files", [])
        for f in files:
            if f["file_name"].endswith(".csv") and "results" in f["file_name"].lower():
                data = requests.get(f"{API}/bundle/{tid}/{f['file_id']}", headers=h, timeout=600)
                data.raise_for_status(); (out / f"{name}.csv").write_bytes(data.content); print("saved", name)

if __name__ == "__main__":
    c = sys.argv[1] if len(sys.argv) > 1 else ""
    {"products": lambda: cmd_products(sys.argv[2]), "record": lambda: cmd_record(sys.argv[2], sys.argv[3]),
     "layers": lambda: cmd_layers(sys.argv[2]), "submit": cmd_submit, "status": cmd_status, "download": cmd_download}.get(
        c, lambda: sys.exit(__doc__))()
