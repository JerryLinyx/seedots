import unittest

from seedots.learning.coach import Coach, CoachSession


class Snap:
    def __init__(self, i: int):
        self.id, self.revision, self.t0, self.t1 = f"ev{i}", 1, float(i), float(i) + 1


class CitationTests(unittest.TestCase):
    def test_grouped_and_ranged_brackets_resolve_every_id(self):
        cs = CoachSession(None, "u", "m")
        for i in (42, 63, 66, 69):
            cs.add(f"s{i:04d}", Snap(i))
        text = "Paid first [s0042]. In installments [s0063, s0069], then work starts [s0066–s0069]. (not from the video)"
        refs = [c["ref"] for c in Coach._citations(cs, text)]
        self.assertEqual(refs, ["s0042", "s0063", "s0069", "s0066", "external"])

    def test_external_marker_tolerates_case_and_colon(self):
        cs = CoachSession(None, "u", "m")
        self.assertEqual(Coach._citations(cs, "*(Not from the video:)* a caveat"), [{"kind": "external", "ref": "external"}])

    def test_unknown_ids_are_dropped(self):
        cs = CoachSession(None, "u", "m")
        self.assertEqual(Coach._citations(cs, "made up [s9999]"), [])


if __name__ == "__main__":
    unittest.main()
