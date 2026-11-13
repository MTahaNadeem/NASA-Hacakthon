"""ONE COMMAND to build all the real data.

    python pipeline/run_all.py            (Windows: python pipeline\\run_all.py, or just double-click build-data.bat)

It does everything and asks you for what it needs:
  1. installs the 'requests' package if it is missing
  2. NASA POWER daily climate for every place in locations.json         (fast, no login)
  3. SoilGrids soil, using the nearest farmland if the pin is on a city (slow server; safe to re-run)
  4. NASA AppEEARS MODIS NDVI + SMAP soil moisture                      (asks for your free Earthdata login; waits for the jobs)
  5. builds app/data/*.json and prints what each place contains
  6. offers to commit and push the new data to GitHub

Safe to stop (Ctrl+C) and re-run: finished work is skipped, AppEEARS jobs are only resubmitted if the list of places changed.
Options: --skip-nasa-login (no MODIS/SMAP)   --refresh (download everything again)   --no-prompt (never ask questions)   --push (push without asking)
"""
import getpass, json, os, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
args = set(sys.argv[1:])
interactive = sys.stdin.isatty() and "--no-prompt" not in args

def step(title): print("\n" + "=" * 8, title, "=" * 8, flush=True)
def run(*cmd, check=True):
    r = subprocess.run([sys.executable, *map(str, cmd)], cwd=ROOT)
    if check and r.returncode: sys.exit(f"\nA step failed: {' '.join(map(str, cmd))}\nFix the message above (or just run this command again; finished steps are skipped).")
    return r.returncode
def ask(q, default=""):
    if not interactive: return default
    try: return input(q).strip()
    except EOFError: return default

step("0/5  Checking tools")
try: import requests  # noqa: F401
except ImportError:
    print("installing the 'requests' package..."); subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet", "requests"])
CFG = json.loads((HERE / "locations.json").read_text())
print(f"{len(CFG['locations'])} places:", ", ".join(l["id"] for l in CFG["locations"]))

def soil_ok(loc):
    f = HERE / "raw" / loc["id"] / "soilgrids.json"
    try:
        layers = json.loads(f.read_text()).get("properties", {}).get("layers", [])
        return any(d.get("values", {}).get("mean") is not None for l in layers for d in l.get("depths", []))
    except Exception: return False

step("1/5  NASA POWER climate")
if "--refresh" in args or any(not (HERE / "raw" / l["id"] / "power.json").exists() for l in CFG["locations"]): run("pipeline/fetch_power.py")
else: print("already downloaded")

step("2/5  SoilGrids soil (the server is slow: this can take 10-30 minutes the first time)")
for attempt in range(1, 4):
    todo = [l["id"] for l in CFG["locations"] if ("--refresh" in args and attempt == 1) or not soil_ok(l)]
    if not todo: print("every place has real soil values"); break
    print(f"round {attempt}: fetching soil for {len(todo)} place(s)"); run("pipeline/fetch_soilgrids.py", *(["--refresh"] if "--refresh" in args and attempt == 1 else []), check=False)
else:
    print("NOTE: no soil values for", [l["id"] for l in CFG["locations"] if not soil_ok(l)], "- those places will show a 'soil data gap' in the app. Run this command again later to retry.")

step("3/5  NASA satellite data: MODIS vegetation + SMAP soil moisture (AppEEARS)")
if "--skip-nasa-login" in args: print("skipped (--skip-nasa-login)")
else:
    if not (os.environ.get("EARTHDATA_USER") and os.environ.get("EARTHDATA_PASS")):
        if interactive:
            print("Enter your free NASA Earthdata Login (https://urs.earthdata.nasa.gov). Press Enter on the username to skip MODIS/SMAP.")
            u = input("  Earthdata username: ").strip()
            if u: os.environ["EARTHDATA_USER"] = u; os.environ["EARTHDATA_PASS"] = getpass.getpass("  Earthdata password (hidden): ")
        else: print("No EARTHDATA_USER / EARTHDATA_PASS set: skipping MODIS/SMAP.")
    if os.environ.get("EARTHDATA_USER"):
        run("pipeline/appeears.py", "submit"); print("Waiting for NASA to prepare the data (the script checks every minute, up to 3 hours)...")
        run("pipeline/appeears.py", "wait", "180"); run("pipeline/appeears.py", "download")
    else: print("skipped: no login given (the app still works; MODIS and SMAP will be listed under data gaps)")

step("4/5  Building the app data")
run("pipeline/build_cache.py")
print("\nWhat each place now contains:")
for loc in CFG["locations"]:
    f = ROOT / "app" / "data" / f"{loc['id']}.json"
    if not f.exists(): print(f"  {loc['id']:<11} NOT BUILT (no POWER data)"); continue
    d = json.loads(f.read_text()); rain = sum(sum(r) for r in d["climate"]["rain"]) / len(d["years"])
    have = [k for k in ("power", "soilgrids", "modis", "smap", "imerg") if k in d.get("sources", {})]
    print(f"  {loc['id']:<11} rain {rain:5.0f} mm/yr | data: {', '.join(have)}")

step("5/5  Save to GitHub")
if not (ROOT / ".git").exists(): print("not a git checkout: nothing to push")
else:
    go = "--push" in args or ask("Commit and push the new data to GitHub now? [y/N] ").lower().startswith("y")
    if go:
        for cmd in (["git", "add", "app/data"], ["git", "commit", "-m", "Add real NASA and SoilGrids data"], ["git", "pull", "--rebase", "origin", "main"], ["git", "push", "origin", "HEAD"]):
            if subprocess.run(cmd, cwd=ROOT).returncode: print("could not run:", " ".join(cmd), "- run it yourself, then you're done"); break
        else: print("pushed.")
    else: print("not pushed. When you are happy: git add app/data && git commit -m \"Real data\" && git push")
print("\nDone. Start the site with:  python -m http.server 8000 --directory app")
