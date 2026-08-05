from clean import add
from complex import classify
from dead import bump
from undefined_name import greet
from unformatted import shout


def run(rows):
    return {
        "total": add(1, 2),
        "score": classify(rows, "a", 3),
        "bumped": bump(1),
        "greeting": greet("world"),
        "shouted": shout("hi"),
    }


if __name__ == "__main__":
    print(run([1, 2, 3]))
