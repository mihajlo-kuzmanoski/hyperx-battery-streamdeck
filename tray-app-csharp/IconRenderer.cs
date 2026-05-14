using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;

namespace HyperXBatteryTray
{
    public static class IconRenderer
    {
        public static Icon Create(int level, bool connected, int size)
        {
            Color color;
            if (!connected) color = Color.FromArgb(160, 160, 160);
            else if (level > 50) color = Color.FromArgb(74, 222, 128);
            else if (level > 20) color = Color.FromArgb(251, 191, 36);
            else color = Color.FromArgb(239, 68, 68);

            string text = connected ? level.ToString() : "--";
            bool small = size <= 24;
            int rs = small ? size : size * 4;
            int oversample = rs / size;

            using (Bitmap big = new Bitmap(rs, rs, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(big))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.Clear(Color.Transparent);

                    using (FontFamily ff = new FontFamily("Arial Black"))
                    using (GraphicsPath path = new GraphicsPath())
                    {
                        float padX = small ? 0.96f : 0.92f;
                        float padY = small ? 0.92f : 0.82f;
                        float fontSize = FitFontSize(text, ff, rs * padX, rs * padY);

                        path.AddString(text, ff, (int)FontStyle.Bold, fontSize,
                            PointF.Empty, StringFormat.GenericTypographic);

                        RectangleF bounds = path.GetBounds();
                        float dx = (rs - bounds.Width) / 2f - bounds.X;
                        float dy = (rs - bounds.Height) / 2f - bounds.Y;
                        using (Matrix m = new Matrix())
                        {
                            m.Translate(dx, dy);
                            path.Transform(m);
                        }

                        if (!small)
                        {
                            // Glow only at larger sizes — at 16-24px there's no room
                            float glowBase = rs / 16f;
                            int[] alphas = new int[] { 30, 65, 120 };
                            float[] widths = new float[] { glowBase * 1.8f, glowBase * 1.1f, glowBase * 0.55f };
                            for (int i = 0; i < 3; i++)
                            {
                                using (Pen glow = new Pen(Color.FromArgb(alphas[i], color), widths[i]))
                                {
                                    glow.LineJoin = LineJoin.Round;
                                    glow.MiterLimit = 1f;
                                    g.DrawPath(glow, path);
                                }
                            }
                        }

                        // Dark contour for contrast on light taskbars
                        float contourWidth = small ? 1.2f : rs / 48f;
                        int contourAlpha = small ? 230 : 200;
                        using (Pen contour = new Pen(Color.FromArgb(contourAlpha, 0, 0, 0), contourWidth))
                        {
                            contour.LineJoin = LineJoin.Round;
                            g.DrawPath(contour, path);
                        }

                        // Main fill
                        using (SolidBrush fill = new SolidBrush(color))
                        {
                            g.FillPath(fill, path);
                        }
                    }
                }

                if (oversample == 1)
                {
                    IntPtr hi = big.GetHicon();
                    try
                    {
                        using (Icon temp = Icon.FromHandle(hi)) return (Icon)temp.Clone();
                    }
                    finally { Native.DestroyIcon(hi); }
                }

                using (Bitmap final = new Bitmap(size, size, PixelFormat.Format32bppArgb))
                {
                    using (Graphics g = Graphics.FromImage(final))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.SmoothingMode = SmoothingMode.HighQuality;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.CompositingQuality = CompositingQuality.HighQuality;
                        g.Clear(Color.Transparent);
                        g.DrawImage(big, new Rectangle(0, 0, size, size));
                    }

                    IntPtr hIcon = final.GetHicon();
                    try
                    {
                        using (Icon temp = Icon.FromHandle(hIcon)) return (Icon)temp.Clone();
                    }
                    finally { Native.DestroyIcon(hIcon); }
                }
            }
        }

        static float FitFontSize(string text, FontFamily ff, float maxW, float maxH)
        {
            float lo = 4f, hi = 400f;
            for (int i = 0; i < 24; i++)
            {
                float mid = (lo + hi) / 2f;
                using (GraphicsPath p = new GraphicsPath())
                {
                    p.AddString(text, ff, (int)FontStyle.Bold, mid,
                        PointF.Empty, StringFormat.GenericTypographic);
                    RectangleF b = p.GetBounds();
                    if (b.Width <= maxW && b.Height <= maxH) lo = mid;
                    else hi = mid;
                }
            }
            return lo;
        }
    }
}
