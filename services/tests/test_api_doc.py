"""docs/api.md must list exactly the routes both services expose."""
import re
import tempfile
import unittest
from pathlib import Path

from fastapi.routing import APIRoute

from seedots.learning.api import create_app as learning_app
from seedots.learning.app import build_container as learning_container
from seedots.media.api import create_app as media_app
from seedots.media.app import build_container as media_container
from tests.support import test_settings

DOC = Path(__file__).resolve().parents[2] / "docs" / "api.md"
ROW = re.compile(r"^\| `(GET|POST|PUT|PATCH|DELETE) (/[^`\s]*)` \|", re.M)


def routes(app) -> set[tuple[str, str]]:
    return {(m, r.path) for r in app.routes if isinstance(r, APIRoute) for m in r.methods if m != "HEAD"}


class ApiDocInSync(unittest.TestCase):
    def test_every_route_is_documented(self):
        with tempfile.TemporaryDirectory() as d:
            settings = test_settings(Path(d))
            mc = media_container(settings, inline=True, poster=lambda *a: 200)
            lc = learning_container(settings, media_http=None, inline=True)
            text = DOC.read_text()
            learning_part, media_part = text.split("## 3. 视频分析底座", 1)
            for name, app, part in (("learning", learning_app(lc), learning_part),
                                    ("media", media_app(mc), media_part)):
                documented = set(ROW.findall(part))
                actual = routes(app)
                self.assertEqual(sorted(actual - documented), [], f"{name}: routes missing from docs/api.md")
                self.assertEqual(sorted(documented - actual), [], f"{name}: docs/api.md lists routes that do not exist")


if __name__ == "__main__":
    unittest.main()
