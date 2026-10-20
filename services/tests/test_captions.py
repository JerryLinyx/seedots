import unittest

from seedots.media.captions import parse_to_sentences
from tests.fixtures import SRT, YOUTUBE_AUTO_VTT


class CaptionTests(unittest.TestCase):
    def test_youtube_rolling_auto_captions_are_deduplicated(self):
        sents = parse_to_sentences(YOUTUBE_AUTO_VTT)
        text = " ".join(s.text for s in sents)
        self.assertEqual(text.count("gradient descent"), 1)
        self.assertEqual(text.count("learning rate"), 1)
        self.assertIn("diverges", text)
        # the pause before 9.0s splits a sentence
        self.assertGreaterEqual(len(sents), 2)
        self.assertTrue(all(s.t1 >= s.t0 for s in sents))
        self.assertEqual(sorted(s.t0 for s in sents), [s.t0 for s in sents])

    def test_srt_cue_with_two_sentences_is_split_with_interpolated_times(self):
        sents = parse_to_sentences(SRT)
        self.assertEqual(len(sents), 4)
        self.assertTrue(sents[0].text.startswith("Gradient descent walks downhill."))
        self.assertAlmostEqual(sents[0].t0, 1.0)
        self.assertLess(sents[0].t1, 4.0)
        self.assertAlmostEqual(sents[1].t1, 4.0, places=2)


if __name__ == "__main__":
    unittest.main()
