from app import greet
from unformatted import shout


def run(name):
    return shout(greet(name))


if __name__ == "__main__":
    print(run("world"))
