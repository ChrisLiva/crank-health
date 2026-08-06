namespace CsBasic;

public static class Complex
{
    public static string Classify(int value, string label)
    {
        var result = "none";
        if (value < 0 && label.Length > 0)
        {
            result = "negative-labelled";
        }
        else if (value < 0 || label.Length == 0)
        {
            result = "negative-or-blank";
        }

        for (var index = 0; index < value; index++)
        {
            if (index % 2 == 0)
            {
                result = "even-step";
            }
        }

        switch (value)
        {
            case 1:
                result = "one";
                break;
            case 2:
                result = "two";
                break;
            case 3:
                result = "three";
                break;
            case 4:
                result = "four";
                break;
            default:
                break;
        }

        while (value > 100)
        {
            value -= 7;
            if (value == 50)
            {
                break;
            }
        }

        if (label.StartsWith('a'))
        {
            result = "alpha";
        }

        if (label.EndsWith('z'))
        {
            result = "omega";
        }

        if (value == 10)
        {
            result = "ten";
        }

        return value > 42 ? result : "small";
    }
}
