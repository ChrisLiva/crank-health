namespace CsBasic;

public static class Program
{
    public static int Main()
    {
        var warnings = new Warnings();
        var total = Clean.Twice(Dead.Reachable(2));
        total += DupeA.Accumulate(System.Array.Empty<int>());
        total += DupeB.Accumulate(System.Array.Empty<int>());
        total += Complex.Classify(total, warnings.Label).Length;
        total += Unformatted.Sum(total, 1);
        return total;
    }
}
