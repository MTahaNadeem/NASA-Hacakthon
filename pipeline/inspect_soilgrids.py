"""Print what is inside the downloaded SoilGrids files, to debug an empty soil table.
Usage: python pipeline/inspect_soilgrids.py
"""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parent
for f in sorted((ROOT / "raw").glob("*/soilgrids.json")):
    d = json.loads(f.read_text()); print("==", f.parent.name, "| top-level keys:", list(d.keys()))
    for layer in d.get("properties", {}).get("layers", []):
        deps = layer.get("depths", [])
        print(" ", layer.get("name"), "unit:", layer.get("unit_measure"), "| depths:", len(deps))
        for dep in deps[:1]: print("    first depth:", json.dumps(dep)[:300])
    if not d.get("properties", {}).get("layers"): print("  no layers; raw start:", f.read_text()[:300])
