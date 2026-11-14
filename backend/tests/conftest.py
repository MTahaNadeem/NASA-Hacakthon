import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, ROOT)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def load(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return json.load(f)


@pytest.fixture
def cache(tmp_path):
    from app.cache import Cache
    return Cache(str(tmp_path / "c.sqlite3"))


@pytest.fixture
def power_2024():
    """REAL NASA POWER response for Lahore 2024 (captured 2026-11-14), parsed."""
    from app.providers import power
    return power.parse(load("power_lahore_2024.json"))
