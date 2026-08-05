from pkg.calc import add, classify


def test_add():
    assert add(1, 2) == 3


# Deliberately weak: only the first branch of `classify` is asserted, and
# `shipping` is never called, so mutants there survive or are never covered.
def test_classify():
    assert classify(50) == "big"
