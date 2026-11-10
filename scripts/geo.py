"""Coördinaattransformaties RD New (EPSG:28992) <-> WGS84 (EPSG:4326)."""
from __future__ import annotations

import numpy as np
import shapely
from pyproj import Transformer

_TO_RD = Transformer.from_crs(4326, 28992, always_xy=True)
_TO_WGS = Transformer.from_crs(28992, 4326, always_xy=True)


def _tf(t):
    def f(xy):
        x, y = t.transform(xy[:, 0], xy[:, 1])
        return np.column_stack([x, y])
    return f


def naar_rd(g):
    return shapely.transform(g, _tf(_TO_RD))


def naar_wgs(g):
    return shapely.transform(g, _tf(_TO_WGS))
