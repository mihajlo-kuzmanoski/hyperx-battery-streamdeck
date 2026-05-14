using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace HyperXBatteryTray
{
    static class Preview
    {
        static void Main()
        {
            string outDir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..\\preview");
            Directory.CreateDirectory(outDir);

            int[] levels = new int[] { 95, 83, 50, 35, 18, 7, 100 };
            int[] sizes = new int[] { 16, 20, 24, 32, 64, 128 };

            foreach (int s in sizes)
            {
                foreach (int lvl in levels)
                {
                    Icon ic = IconRenderer.Create(lvl, true, s);
                    using (Bitmap bmp = ic.ToBitmap())
                    {
                        bmp.Save(Path.Combine(outDir, "lvl" + lvl + "_" + s + "px.png"), ImageFormat.Png);
                    }
                    ic.Dispose();
                }
                Icon dc = IconRenderer.Create(0, false, s);
                using (Bitmap bmp = dc.ToBitmap())
                {
                    bmp.Save(Path.Combine(outDir, "disconnected_" + s + "px.png"), ImageFormat.Png);
                }
                dc.Dispose();
            }
            Console.WriteLine("Preview PNGs written to " + outDir);
        }
    }
}
