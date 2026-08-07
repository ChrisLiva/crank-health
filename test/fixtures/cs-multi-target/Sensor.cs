namespace CsMultiTarget;

public sealed class Sensor
{
    private readonly int unusedReading = 7;

    public static int Twice(int value)
    {
        var unused = "spare";
        return value * 2;
    }
}
