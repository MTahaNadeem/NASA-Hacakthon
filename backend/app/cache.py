"""Small SQLite cache. Production can swap this for Postgres/Redis with the same
get/put interface; SQLite is enough for a hackathon and needs no service."""
import json
import sqlite3
import threading
import time

from . import config


class Cache:
    def __init__(self, path=None):
        self.path = path or config.CACHE_DB
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, fetched_at REAL NOT NULL, expires_at REAL NOT NULL)")
        self._db.commit()

    def get(self, key, allow_stale=False):
        """Return (value, fetched_at, is_stale) or None."""
        with self._lock:
            row = self._db.execute("SELECT v, fetched_at, expires_at FROM kv WHERE k=?", (key,)).fetchone()
        if not row:
            return None
        v, fetched, expires = row
        stale = time.time() > expires
        if stale and not allow_stale:
            return None
        return json.loads(v), fetched, stale

    def put(self, key, value, ttl):
        now = time.time()
        with self._lock:
            self._db.execute("INSERT OR REPLACE INTO kv (k, v, fetched_at, expires_at) VALUES (?,?,?,?)",
                             (key, json.dumps(value), now, now + ttl))
            self._db.commit()

    def fetch(self, key, ttl, loader):
        """Cache-aside. Fresh hit -> stored value. Miss -> loader(). If the loader
        fails and an old copy exists, serve the old copy flagged as stale so the
        UI can say so; if there is no copy, the error propagates (no invented data)."""
        hit = self.get(key)
        if hit:
            return hit[0], hit[1], False, True
        try:
            value = loader()
        except Exception:
            old = self.get(key, allow_stale=True)
            if old:
                return old[0], old[1], True, True
            raise
        self.put(key, value, ttl)
        return value, time.time(), False, False
