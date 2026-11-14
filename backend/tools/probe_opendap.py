"""Find out, with YOUR Earthdata token, how NASA lets a server read ONE POINT of SMAP and IMERG.

Why: the site shows SMAP/IMERG as "not available" because their data needs a NASA login. A server can hold one login
(your token). Before building the reader we need real answers to: does NASA's OPeNDAP service accept the token, what are
the variables called, and can one grid cell be requested without downloading a whole file? This script asks, and writes
the answers to a report you can paste back. It needs only `requests` (already installed by the pipeline).

    1. https://urs.earthdata.nasa.gov  ->  profile  ->  Generate Token  (copy it)
    2. PowerShell:   $env:EARTHDATA_TOKEN = "paste-token-here"
       macOS/Linux:  export EARTHDATA_TOKEN="paste-token-here"
    3. python backend/tools/probe_opendap.py

The token is read from the environment, sent only to NASA hosts, and never printed or written to the report."""
import os
import re
import sys
import xml.etree.ElementTree as ET

import requests

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
PRODUCTS = [("SMAP L3 9 km soil moisture", "SPL3SMP_E", "soil_moisture"), ("GPM IMERG daily rain", "GPM_3IMERGDL", "precipitation")]
LINES = []


def say(msg=""):
    print(msg)
    LINES.append(msg)


def newest(short_name):
    r = requests.get(CMR, params={"short_name": short_name, "sort_key": "-start_date", "page_size": 1}, timeout=45)
    r.raise_for_status()
    umm = r.json()["items"][0]["umm"]
    links = umm["RelatedUrls"]
    opendap = next((x["URL"] for x in links if x["Type"] == "USE SERVICE API" and "opendap" in x["URL"]), None)
    https = next((x["URL"] for x in links if x["Type"] == "GET DATA" and x["URL"].startswith("https://")), None)
    return umm["GranuleUR"], opendap, https


def strip_ns(tag):
    return tag.split("}", 1)[-1]


def find_variables(dmr_xml, wanted):
    """Walk the DAP4 metadata and return [(path, dimensions)] for variables called `wanted`."""
    root, found = ET.fromstring(dmr_xml), []

    def walk(node, path):
        for ch in node:
            tag = strip_ns(ch.tag)
            if tag == "Group":
                walk(ch, path + "/" + ch.get("name", ""))
            elif ch.get("name") == wanted:
                dims = [d.get("name") or d.get("size") for d in ch if strip_ns(d.tag) == "Dim"]
                found.append((path + "/" + wanted, dims))
    walk(root, "")
    return found


def dim_sizes(dmr_xml):
    root, sizes = ET.fromstring(dmr_xml), {}
    for el in root.iter():
        if strip_ns(el.tag) == "Dimension" and el.get("name"):
            sizes[el.get("name")] = el.get("size")
    return sizes


def attempt(label, fn):
    """Run one network step; a failure is a finding to report, never a crash."""
    try:
        return fn()
    except requests.RequestException as e:
        say("  %s: FAILED (%s)" % (label, e.__class__.__name__))
        return None


def main():
    token = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not token:
        print("EARTHDATA_TOKEN is not set. See the instructions at the top of this file.")
        return 2
    auth = {"Authorization": "Bearer " + token}
    say("Earthdata probe (token not shown)")
    for label, short, var in PRODUCTS:
        say("\n== %s ==" % label)
        try:
            granule, opendap, https = newest(short)
        except Exception as e:
            say("  FAIL could not find the newest file: %s" % e.__class__.__name__)
            continue
        say("  newest granule: %s" % granule)
        # 1. does OPeNDAP accept the token? (no redirect following, so a login redirect is visible)
        if opendap:
            r = attempt("OPeNDAP metadata", lambda: requests.get(opendap + ".dmr.xml", headers=auth, timeout=90, allow_redirects=False))
            if r is not None:
                loc = r.headers.get("Location", "")
                say("  OPeNDAP metadata with token: HTTP %d %s" % (r.status_code, ("-> " + loc[:90]) if loc else ""))
                if r.status_code == 200:
                    found = find_variables(r.text, var)
                    say("  variables named '%s': %s" % (var, found[:4] or "none found"))
                    say("  dimension sizes: %s" % dict(list(dim_sizes(r.text).items())[:8]))
                    if found:
                        path, dims = found[0]
                        # one grid cell, just to see the shape of the answer (not a real location)
                        idx = "".join("[0]" if (d or "").lower() in ("time",) else "[100]" for d in dims)
                        ce = "dap4.ce=%s%s" % (path, idx)
                        r2 = attempt("one-cell request", lambda: requests.get(opendap + ".dap?" + ce, headers=auth, timeout=120, allow_redirects=False))
                        if r2 is not None:
                            say("  one-cell request %s: HTTP %d, %d bytes (a whole file would be many MB)" % (ce, r2.status_code, len(r2.content)))
                            if r2.status_code != 200:
                                say("    body starts: %r" % r2.content[:160])
                elif r.status_code in (301, 302, 303, 307, 308):
                    r3 = attempt("after following the redirect", lambda: requests.get(opendap + ".dmr.xml", headers=auth, timeout=90, allow_redirects=True))
                    if r3 is not None:
                        say("  after following redirects: HTTP %d at %s" % (r3.status_code, r3.url.split("?")[0][:80]))
                    say("  -> NASA's service did not accept the token as a Bearer header on this host.")
        # 2. can the data file itself be read in pieces (cloud-native access)?
        if https:
            r4 = attempt("direct file read", lambda: requests.get(https, headers=dict(auth, Range="bytes=0-1023"), timeout=90, allow_redirects=True))
            if r4 is not None:
                head = r4.content[:8]
                ok = r4.status_code in (200, 206) and (head.startswith(b"\x89HDF") or head.startswith(b"CDF"))
                say("  direct file, first 1 KB with token: HTTP %d, %s" % (r4.status_code, "looks like an HDF5/NetCDF file" if ok else "NOT a data file: %r" % head))
    say("\nPaste everything above back to the maintainer. Nothing in it contains your token.")
    try:
        with open("opendap_probe_report.txt", "w", encoding="utf-8") as f:
            f.write("\n".join(LINES))
        print("(also saved as opendap_probe_report.txt)")
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
