"""Native grid cells. Cache keys use the cell, not the typed coordinate, so that
every farmer inside one NASA POWER cell shares ONE upstream request (POWER's own
documentation asks clients to make one request per cell)."""

POWER_LAT_STEP = 0.5     # meteorology grid: 1/2 degree latitude ...
POWER_LON_STEP = 0.625   # ... by 5/8 degree longitude (POWER methodology page)
MODIS_STEP = 0.002       # ~220 m, close to the 250 m MODIS pixel


def check_lat_lon(lat, lon):
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise ValueError("lat must be in [-90, 90] and lon in [-180, 180]")
    return float(lat), float(lon)


def power_cell(lat, lon):
    """Index and centre of the POWER meteorology cell holding the point."""
    i, j = round(lat / POWER_LAT_STEP), round(lon / POWER_LON_STEP)
    return {"i": i, "j": j, "lat": round(i * POWER_LAT_STEP, 4), "lon": round(j * POWER_LON_STEP, 4),
            "key": "%d_%d" % (i, j)}


def modis_cell(lat, lon):
    i, j = round(lat / MODIS_STEP), round(lon / MODIS_STEP)
    return "%d_%d" % (i, j)
