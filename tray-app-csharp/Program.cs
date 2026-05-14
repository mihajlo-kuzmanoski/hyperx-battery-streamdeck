using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace HyperXBatteryTray
{
    static class Program
    {
        const string MUTEX_NAME = "Local\\HyperXBatteryTray.Mutex";

        [STAThread]
        static void Main()
        {
            try
            {
                bool created;
                using (Mutex m = new Mutex(true, MUTEX_NAME, out created))
                {
                    if (!created) return;
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    Application.Run(new TrayApp());
                }
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "HyperXBattery-crash.log"), ex.ToString()); } catch { }
                MessageBox.Show(ex.ToString(), "HyperX Battery — startup error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
    }

    class TrayApp : ApplicationContext
    {
        const int POLL_MS = 60000;
        const int LOW_WARN = 20;
        const int FAIL_THRESH = 3;
        const string RUN_KEY = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string APP_NAME = "HyperXBatteryTray";

        readonly NotifyIcon tray;
        readonly System.Windows.Forms.Timer timer;
        BatteryState cached;
        bool hasCache;
        int failStreak;
        bool alerted;
        IntPtr currentIconHandle = IntPtr.Zero;

        public TrayApp()
        {
            tray = new NotifyIcon();
            tray.Icon = IconRenderer.Create(0, false, SystemInformation.SmallIconSize.Width);
            tray.Visible = true;
            tray.Text = "HyperX Battery";
            tray.MouseClick += OnTrayClick;

            BuildMenu("Loading...");
            Update();

            timer = new System.Windows.Forms.Timer();
            timer.Interval = POLL_MS;
            timer.Tick += delegate { Update(); };
            timer.Start();
        }

        void OnTrayClick(object sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) return;
            MethodInfo mi = typeof(NotifyIcon).GetMethod("ShowContextMenu",
                BindingFlags.Instance | BindingFlags.NonPublic);
            if (mi != null) mi.Invoke(tray, null);
        }

        BatteryState ReadStable()
        {
            BatteryState s = BatteryReader.Read();
            if (s.Connected)
            {
                cached = s;
                hasCache = true;
                failStreak = 0;
                return s;
            }
            failStreak++;
            if (hasCache && failStreak < FAIL_THRESH) return cached;
            hasCache = false;
            return s;
        }

        void Update()
        {
            BatteryState s = ReadStable();
            string label = s.Connected ? (s.Level.ToString() + "%") : "Disconnected";

            int iconSize = SystemInformation.SmallIconSize.Width;
            Icon newIcon = IconRenderer.Create(s.Connected ? s.Level : 0, s.Connected, iconSize);
            IntPtr oldHandle = currentIconHandle;
            currentIconHandle = newIcon.Handle;
            tray.Icon = newIcon;
            if (oldHandle != IntPtr.Zero) Native.DestroyIcon(oldHandle);

            tray.Text = "HyperX Battery: " + label;
            BuildMenu(label);

            if (s.Connected && s.Level <= LOW_WARN && !alerted)
            {
                alerted = true;
                tray.ShowBalloonTip(5000,
                    "HyperX Battery Low",
                    "Battery is at " + s.Level + "% — plug in to charge",
                    ToolTipIcon.Warning);
            }
            if (!s.Connected || s.Level > LOW_WARN) alerted = false;
        }

        void BuildMenu(string label)
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add("HyperX Battery  ·  " + label).Enabled = false;
            menu.Items.Add(new ToolStripSeparator());

            ToolStripMenuItem startup = new ToolStripMenuItem("Launch at startup");
            startup.Checked = IsLaunchAtStartup();
            startup.CheckOnClick = true;
            startup.Click += delegate { SetLaunchAtStartup(!IsLaunchAtStartup()); };
            menu.Items.Add(startup);

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, delegate { ExitThread(); });

            ContextMenuStrip old = tray.ContextMenuStrip;
            tray.ContextMenuStrip = menu;
            if (old != null) old.Dispose();
        }

        static bool IsLaunchAtStartup()
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY, false))
                {
                    if (key == null) return false;
                    object v = key.GetValue(APP_NAME);
                    return v != null;
                }
            }
            catch { return false; }
        }

        static void SetLaunchAtStartup(bool enable)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RUN_KEY, true))
                {
                    if (key == null) return;
                    if (enable)
                    {
                        string exe = Application.ExecutablePath;
                        key.SetValue(APP_NAME, "\"" + exe + "\"");
                    }
                    else
                    {
                        if (key.GetValue(APP_NAME) != null) key.DeleteValue(APP_NAME);
                    }
                }
            }
            catch { }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (timer != null) timer.Dispose();
                if (tray != null)
                {
                    tray.Visible = false;
                    tray.Dispose();
                }
                if (currentIconHandle != IntPtr.Zero) Native.DestroyIcon(currentIconHandle);
            }
            base.Dispose(disposing);
        }
    }
}
