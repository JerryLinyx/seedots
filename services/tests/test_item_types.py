import unittest

from seedots.learning.item_types import InvalidItem, ItemDraft, build, grade


def draft(**kw):
    base = dict(type="single_choice", concept="c", level=1, stem="Which?", options=["a", "b", "c"], answer=1,
                evidence=["s0001"], hints=["think about it"])
    base.update(kw)
    return ItemDraft.model_validate(base)


class ItemTypeTests(unittest.TestCase):
    def test_single_choice_roundtrip(self):
        t, p, a = build(draft())
        self.assertTrue(grade(t.name, p.model_dump(), a.model_dump(), {"index": 1}))
        self.assertFalse(grade(t.name, p.model_dump(), a.model_dump(), {"index": 0}))

    def test_rejects_duplicate_options_bad_index_and_leaky_hint(self):
        with self.assertRaises(InvalidItem):
            build(draft(options=["a", "A", "b"]))
        with self.assertRaises(InvalidItem):
            build(draft(answer=5))
        with self.assertRaises(InvalidItem):
            build(draft(options=["red apple", "green pear", "blue plum"], answer=0,
                        hints=["the answer is red apple"]))

    def test_ordering_is_shuffled_and_graded_by_true_order(self):
        steps = ["borrow", "spend", "income rises", "debt grows"]
        t, p, a = build(draft(type="ordering", items=steps, answer=None, options=None))
        self.assertNotEqual(p.items, steps)
        self.assertEqual([p.items[i] for i in a.order], steps)
        self.assertTrue(grade("ordering", p.model_dump(), a.model_dump(), {"order": a.order}))

    def test_matching_and_multi(self):
        t, p, a = build(draft(type="matching", left=["x", "y", "z"], right=["1", "2", "3"], options=None,
                              answer=None))
        self.assertEqual([p.right[j] for j in a.pairs], ["1", "2", "3"])
        t, p, a = build(draft(type="multi_choice", options=["a", "b", "c", "d"], answer=[2, 0]))
        self.assertTrue(grade("multi_choice", p.model_dump(), a.model_dump(), {"indices": [0, 2]}))

    def test_unknown_type(self):
        with self.assertRaises(InvalidItem):
            build(draft(type="essay"))


if __name__ == "__main__":
    unittest.main()
