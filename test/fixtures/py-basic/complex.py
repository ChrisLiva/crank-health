def classify(items, mode, limit):
    total = 0
    for item in items:
        if mode == "a":
            if item > limit:
                for _ in range(3):
                    if item % 2 == 0:
                        total += item
                    else:
                        total -= item
            elif item < 0:
                while total > 0:
                    total -= 1
                    if total == 5:
                        break
            else:
                total += 1
        elif mode == "b":
            try:
                total += int(item)
            except ValueError:
                total -= 1
            else:
                if total > 100:
                    total = 100
        else:
            total = total if total else 1
    return total
