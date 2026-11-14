"""Tiny per-IP limiter so one client cannot run the upstream quota down for everybody."""
import threading
import time


class RateLimiter:
    def __init__(self, per_minute):
        self.per_minute, self._hits, self._lock = per_minute, {}, threading.Lock()

    def allow(self, who):
        if self.per_minute <= 0:
            return True
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(who, []) if now - t < 60]
            ok = len(hits) < self.per_minute
            if ok:
                hits.append(now)
            self._hits[who] = hits
            if len(self._hits) > 5000:   # bound memory
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < 60}
        return ok
