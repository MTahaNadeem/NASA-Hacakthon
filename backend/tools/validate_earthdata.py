"""Check whether YOUR Earthdata token can actually read SMAP and IMERG files.

Why this exists: the backend only reports SMAP/IMERG as 'discovery_only' until this has been shown to
work with a real token. It could not be run in the environment where the backend was built, so this
script is the test for the one part that is not verified yet.

    1. Create a token:  https://urs.earthdata.nasa.gov  ->  Generate Token   (free account)
    2. Windows PowerShell:   $env:EARTHDATA_TOKEN = "paste-token-here"
       macOS/Linux:          export EARTHDATA_TOKEN="paste-token-here"
    3. python backend/tools/validate_earthdata.py

The token is read from the environment only. It is never printed or written to a file.
"""
import os
import sys

import httpx

CMR = "https://cmr.earthdata.nasa.gov/search/granules.umm_json"
PRODUCTS = [("SMAP L3 9 km soil moisture", "SPL3SMP_E"), ("GPM IMERG daily rain", "GPM_3IMERGDL")]


def newest_url(short_name):
    r = httpx.get(CMR, params={"short_name": short_name, "sort_key": "-start_date", "page_size": 1}, timeout=45)
    r.raise_for_status()
    umm = r.json()["items"][0]["umm"]
    for link in umm.get("RelatedUrls", []):
        if link.get("Type") == "GET DATA" and link["URL"].startswith("https://"):
            return umm["GranuleUR"], link["URL"]
    raise RuntimeError("no https download link in CMR record")


def main():
    token = os.environ.get("EARTHDATA_TOKEN", "").strip()
    if not token:
        print("EARTHDATA_TOKEN is not set. See the instructions at the top of this file.")
        return 2
    ok_all = True
    for label, short in PRODUCTS:
        try:
            granule, url = newest_url(short)
        except Exception as e:
            print("FAIL  %-30s could not find newest file: %s" % (label, e.__class__.__name__)); ok_all = False; continue
        try:
            with httpx.Client(follow_redirects=True, timeout=60) as c:
                r = c.get(url, headers={"Authorization": "Bearer " + token, "Range": "bytes=0-1023"})
        except Exception as e:
            print("FAIL  %-30s network error: %s" % (label, e.__class__.__name__)); ok_all = False; continue
        head = r.content[:8]
        looks_like_data = head.startswith(b"\x89HDF") or head.startswith(b"CDF") or head.startswith(b"\x89HDF\r\n")
        if r.status_code in (200, 206) and looks_like_data:
            print("PASS  %-30s HTTP %d, file header looks like HDF5/NetCDF (%s)" % (label, r.status_code, granule))
        else:
            ok_all = False
            print("FAIL  %-30s HTTP %d, first bytes %r (%s)" % (label, r.status_code, head, granule))
            if r.status_code in (401, 403) or b"<html" in r.content[:200].lower():
                print("      The token was not accepted for this host. Check it has not expired and that you approved the")
                print("      'NSIDC DAAC Data Access' / 'GES DISC' applications on your Earthdata profile (Applications > Authorized Apps).")
    print()
    print("ALL PASSED: the SMAP/IMERG reader can now be built on this token." if ok_all else
          "NOT PASSED: the backend will keep reporting SMAP/IMERG as discovery-only. Nothing is faked.")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
