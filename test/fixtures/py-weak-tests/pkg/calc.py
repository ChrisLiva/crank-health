def add(a, b):
    return a + b


def classify(n):
    if n > 10:
        return "big"
    if n > 0:
        return "small"
    return "none"


def shipping(weight, express):
    if weight > 20:
        return 40 if express else 25
    return 15 if express else 5
