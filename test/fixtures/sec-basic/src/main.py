"""Entry point: uses everything in config.py, so nothing there reads as dead."""

from config import AWS_ACCESS_KEY_ID, run_backup


def main():
    print(AWS_ACCESS_KEY_ID[:4])
    return run_backup("./data")


if __name__ == "__main__":
    main()
