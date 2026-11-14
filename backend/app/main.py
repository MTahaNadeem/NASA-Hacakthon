"""AgriShift AI / Rotation Explorer - NASA data backend.

Run:  uvicorn app.main:app --port 8000     (from the backend/ folder)
"""
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

from . import config, service
from .cache import Cache
from .providers.cmr import CmrError
from .providers.modis import ModisError
from .providers.power import PowerError
from .providers.soilgrids import SoilError
from .ratelimit import RateLimiter

app = FastAPI(title="AgriShift AI NASA data API", version="0.1.0",
              description="Real NASA data for any coordinate. No farmer credentials. Every value carries provenance.")
app.add_middleware(CORSMiddleware, allow_origins=config.ALLOWED_ORIGINS, allow_methods=["GET"], allow_headers=["*"])

_cache = None
_limiter = RateLimiter(config.RATE_LIMIT_PER_MIN)


def get_cache():
    global _cache
    if _cache is None:
        _cache = Cache()
    return _cache


def limited(request: Request):
    who = request.client.host if request.client else "unknown"
    if not _limiter.allow(who):
        raise HTTPException(429, "Too many requests. Please wait a minute.")


LAT = Query(..., ge=-90, le=90, description="Latitude, degrees")
LON = Query(..., ge=-180, le=180, description="Longitude, degrees")


def _upstream(fn):
    try:
        return fn()
    except ValueError as e:
        raise HTTPException(422, str(e))
    except (PowerError, ModisError, CmrError, SoilError) as e:
        # a real failure is reported as a failure; no substitute numbers are ever invented
        raise HTTPException(502, "NASA data source unavailable: %s" % e)


@app.get("/api/health")
def health():
    return {"status": "ok", "earthdata_server_token_configured": bool(config.EARTHDATA_TOKEN)}


@app.get("/api/sources")
def sources():
    return service.sources()


@app.get("/api/location", dependencies=[Depends(limited)])
def location(lat: float = LAT, lon: float = LON, cache: Cache = Depends(get_cache)):
    """Climate, rainfall, soil-wetness, indicators and satellite freshness. Fast (about 1-2 s on a cache miss)."""
    return _upstream(lambda: service.climate(lat, lon, cache))


@app.get("/api/ndvi", dependencies=[Depends(limited)])
def ndvi(lat: float = LAT, lon: float = LON, months: int = Query(12, ge=1, le=36), cache: Cache = Depends(get_cache)):
    """MODIS vegetation greenness for the pixel. Slower (a few seconds on a miss), so it is a separate call."""
    return _upstream(lambda: service.ndvi(lat, lon, cache, months=months))


@app.get("/api/soil", dependencies=[Depends(limited)])
def soil(lat: float = LAT, lon: float = LON, cache: Cache = Depends(get_cache)):
    """Soil pH, organic carbon, clay, sand, silt (with 5th-95th percentile range) for the nearest mapped land. About 4-6 s the first time."""
    return _upstream(lambda: service.soil(lat, lon, cache))
