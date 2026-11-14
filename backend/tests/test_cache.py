import pytest
from app.cache import Cache


def test_second_call_is_served_from_cache_and_loader_not_called(cache):
    calls = []
    v1 = cache.fetch("k", 60, lambda: calls.append(1) or {"a": 1})
    v2 = cache.fetch("k", 60, lambda: calls.append(1) or {"a": 2})
    assert v1[0] == v2[0] == {"a": 1} and len(calls) == 1
    assert v1[3] is False and v2[3] is True


def test_expired_entry_is_refetched(cache):
    cache.fetch("k", -1, lambda: {"a": 1})          # already expired
    v, _, stale, hit = cache.fetch("k", 60, lambda: {"a": 2})
    assert v == {"a": 2} and not hit


def test_failed_refresh_serves_old_copy_flagged_stale(cache):
    cache.fetch("k", -1, lambda: {"a": 1})
    def boom(): raise RuntimeError("upstream down")
    v, _, stale, hit = cache.fetch("k", 60, boom)
    assert v == {"a": 1} and stale is True


def test_failure_with_nothing_cached_raises_no_invented_data(cache):
    def boom(): raise RuntimeError("upstream down")
    with pytest.raises(RuntimeError):
        cache.fetch("never-seen", 60, boom)
