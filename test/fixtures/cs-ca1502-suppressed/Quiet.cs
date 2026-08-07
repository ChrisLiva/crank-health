namespace CsSuppressed;

public sealed class Quiet
{
    private readonly int unusedTally = 3;

    public static int Halve(int value)
    {
        return value / 2;
    }
}
