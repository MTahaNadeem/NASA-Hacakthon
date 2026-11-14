"""Build app/data/soilgrids_tiles_<property>.json from ISRIC's published VRTs (run once; results are committed).

A VRT is ~3.5 MB of XML and takes seconds to open, which is too slow for a web request. Different properties use different
tile layouts (pH is 600x600, the others 450x450), so each property gets its own compact index.
Usage: python tools/build_soil_tile_index.py [outdir] [--verify]   (--verify also checks other depths/percentiles match)"""
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.request

BASE = "https://files.isric.org/soilgrids/latest/data/"
PROPS = ["phh2o", "soc", "sand", "silt", "clay"]
DEPTHS = ["0-5cm", "5-15cm", "15-30cm"]
STATS = ["mean", "Q0.05", "Q0.95"]


def parse(prop, layer):
    url = "%s%s/%s_%s.vrt" % (BASE, prop, prop, layer)
    xml = urllib.request.urlopen(url, timeout=180).read().decode()
    gt = [float(x) for x in re.search(r"<GeoTransform>([^<]+)</GeoTransform>", xml).group(1).split(",")]
    size = [int(re.search(r'rasterXSize="(\d+)"', xml).group(1)), int(re.search(r'rasterYSize="(\d+)"', xml).group(1))]
    pat = r"<SourceFilename[^>]*>\./%s_%s/(tileSG-\d+-\d+)/(?:tileSG-\d+-\d+)_(\d+-\d+)\.tif</SourceFilename>.*?<DstRect xOff=\"(\d+)\" yOff=\"(\d+)\" xSize=\"(\d+)\" ySize=\"(\d+)\"" % (prop, layer)
    tiles = [[int(x), int(y), int(xs), int(ys), d, s] for d, s, x, y, xs, ys in re.findall(pat, xml, re.S)]
    if not tiles:
        raise SystemExit("no tiles parsed for %s %s" % (prop, layer))
    return {"geotransform": gt, "size": size, "source": url, "tiles": tiles}


def main():
    out = next((a for a in sys.argv[1:] if not a.startswith("--")), "app/data")
    verify = "--verify" in sys.argv
    with cf.ThreadPoolExecutor(max_workers=5) as ex:
        base = dict(zip(PROPS, ex.map(lambda p: parse(p, "0-5cm_mean"), PROPS)))
    for p, d in base.items():
        json.dump(d, open(os.path.join(out, "soilgrids_tiles_%s.json" % p), "w"), separators=(",", ":"))
        sizes = {(t[2], t[3]) for t in d["tiles"]}
        print("%-6s tiles=%d  dominant tile size=%s" % (p, len(d["tiles"]), max(sizes, key=lambda s: sum(1 for t in d["tiles"] if (t[2], t[3]) == s))))
    if verify:
        layers = [(p, "%s_%s" % (d, s)) for p in PROPS for d in DEPTHS for s in STATS if (d, s) != ("0-5cm", "mean")]
        def chk(pl):
            p, l = pl
            other = parse(p, l)
            return p, l, other["tiles"] == base[p]["tiles"] and other["geotransform"] == base[p]["geotransform"]
        with cf.ThreadPoolExecutor(max_workers=6) as ex:
            res = list(ex.map(chk, layers))
        bad = [(p, l) for p, l, ok in res if not ok]
        print("verified %d other layers: %s" % (len(res), "ALL IDENTICAL layout within each property" if not bad else "MISMATCH: %s" % bad))
        if bad:
            sys.exit(1)


if __name__ == "__main__":
    main()
