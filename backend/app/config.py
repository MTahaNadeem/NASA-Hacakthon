"""Backend settings. Everything comes from environment variables so that no
secret ever has to live in the repository or in the frontend."""
import os


def _int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Optional. Only the server holds it. It is never logged, never returned by an endpoint.
EARTHDATA_TOKEN = os.environ.get("EARTHDATA_TOKEN", "").strip()

CACHE_DB = os.environ.get("CACHE_DB", os.path.join(os.path.dirname(__file__), "..", "cache.sqlite3"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

# How long a cached answer may be reused (seconds). POWER only changes once a day;
# MODIS composites change every 8-16 days; CMR listings change daily.
TTL_POWER = _int("TTL_POWER", 6 * 3600)
TTL_MODIS_SEARCH = _int("TTL_MODIS_SEARCH", 12 * 3600)
TTL_MODIS_PIXEL = _int("TTL_MODIS_PIXEL", 30 * 86400)   # a finished composite does not change
TTL_CMR = _int("TTL_CMR", 3 * 3600)
TTL_SOIL = _int("TTL_SOIL", 90 * 86400)       # soil maps do not change

HTTP_TIMEOUT = _int("HTTP_TIMEOUT", 45)
RATE_LIMIT_PER_MIN = _int("RATE_LIMIT_PER_MIN", 60)

POWER_START_YEAR = _int("POWER_START_YEAR", 2005)

# The only hosts this backend will ever talk to.
UPSTREAM_HOSTS = {
    "power.larc.nasa.gov",
    "planetarycomputer.microsoft.com",
    "modiseuwest.blob.core.windows.net",
    "cmr.earthdata.nasa.gov",
    "files.isric.org",
}
