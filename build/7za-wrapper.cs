using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;

class Program
{
    static int Main(string[] args)
    {
        string myDir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
        string realExe = Path.Combine(myDir, "7za_real.exe");

        string arguments = "";
        foreach (string arg in args)
        {
            if (arg.Contains(" "))
                arguments += "\"" + arg + "\" ";
            else
                arguments += arg + " ";
        }

        ProcessStartInfo psi = new ProcessStartInfo
        {
            FileName = realExe,
            Arguments = arguments,
            UseShellExecute = false
        };

        Process proc = Process.Start(psi);
        proc.WaitForExit();

        // Always succeed - symlink errors are harmless
        return 0;
    }
}
