using System;

namespace HyperXBatteryTray
{
    static class Cli
    {
        static int Main(string[] args)
        {
            BatteryState s = BatteryReader.Read();
            if (s.Connected)
            {
                Console.Write(s.Level);
                return 0;
            }
            Console.Write("DISCONNECTED");
            return 1;
        }
    }
}
