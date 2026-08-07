namespace MixedCs;

public static class DupeA
{
    public static int Accumulate(int[] values)
    {
        var total = 0;
        var count = 0;
        var minimum = int.MaxValue;
        var maximum = int.MinValue;
        foreach (var value in values)
        {
            total += value;
            count += 1;
            if (value < minimum)
            {
                minimum = value;
            }

            if (value > maximum)
            {
                maximum = value;
            }
        }

        if (count == 0)
        {
            return 0;
        }

        return total + minimum + maximum;
    }
}
