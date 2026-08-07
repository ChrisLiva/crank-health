namespace CsBasic;

public static class Dead
{
    public static int Reachable(int value)
    {
        return value * 3;
    }

    public static int NeverCalled(int value)
    {
        return value + 1;
    }
}
