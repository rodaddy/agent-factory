"""Test-only (tests/fleet/jev-route.test.ts): fake the Jev endpoint inside the
real jev-route child process. Put this directory on PYTHONPATH and set
FAKE_JEV_SCORE and FAKE_JEV_CONFIDENCE: a POST to api.typesafe.ai answers that
score for every question asked; every other request goes out for real.
"""
import io
import json
import os
import urllib.request

_real = urllib.request.urlopen


class _Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _urlopen(req, *args, **kwargs):
    url = req.full_url if isinstance(req, urllib.request.Request) else req
    if not url.startswith("https://api.typesafe.ai/"):
        return _real(req, *args, **kwargs)
    asked = json.loads(req.data.decode())["questions"]
    a = {"score": float(os.environ["FAKE_JEV_SCORE"]), "confidence": float(os.environ["FAKE_JEV_CONFIDENCE"])}
    return _Answer(json.dumps({"answers": {k: a for k in asked}}).encode())


urllib.request.urlopen = _urlopen
