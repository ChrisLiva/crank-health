from greet import greet


def run(names):
    return [greet(name) for name in names]


if __name__ == "__main__":
    print(run(["world"]))
