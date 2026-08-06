from app import label, total


def run(values):
    return label(total(values))


if __name__ == "__main__":
    print(run([1, 2, 3]))
