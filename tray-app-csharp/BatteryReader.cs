using System;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace HyperXBatteryTray
{
    public struct BatteryState
    {
        public bool Connected;
        public int Level;
    }

    public static class BatteryReader
    {
        const ushort VID = 0x03F0;
        const ushort PID = 0x05B7;
        const ushort USAGE_PAGE = 0xFF13;
        const int READ_TIMEOUT_MS = 1000;

        public static BatteryState Read()
        {
            string path = FindDevicePath();
            if (path == null) return new BatteryState { Connected = false };

            SafeFileHandle handle = Native.CreateFile(
                path,
                Native.GENERIC_READ | Native.GENERIC_WRITE,
                Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE,
                IntPtr.Zero,
                Native.OPEN_EXISTING,
                Native.FILE_FLAG_OVERLAPPED,
                IntPtr.Zero);

            if (handle.IsInvalid) return new BatteryState { Connected = false };

            IntPtr preparsed = IntPtr.Zero;
            try
            {
                if (!Native.HidD_GetPreparsedData(handle, out preparsed))
                    return new BatteryState { Connected = false };

                Native.HIDP_CAPS caps;
                if (Native.HidP_GetCaps(preparsed, out caps) != Native.HIDP_STATUS_SUCCESS)
                    return new BatteryState { Connected = false };

                int outSize = Math.Max(52, (int)caps.OutputReportByteLength);
                byte[] req = new byte[outSize];
                req[0] = 0x66;
                req[1] = 0x89;

                if (!WriteOverlapped(handle, req, READ_TIMEOUT_MS))
                    return new BatteryState { Connected = false };

                int inSize = caps.InputReportByteLength;
                if (inSize < 5) return new BatteryState { Connected = false };

                byte[] response = new byte[inSize];
                int read;
                if (!ReadOverlapped(handle, response, READ_TIMEOUT_MS, out read))
                    return new BatteryState { Connected = false };

                if (read < 5 || response[4] > 100)
                    return new BatteryState { Connected = false };

                return new BatteryState { Connected = true, Level = response[4] };
            }
            catch
            {
                return new BatteryState { Connected = false };
            }
            finally
            {
                if (preparsed != IntPtr.Zero) Native.HidD_FreePreparsedData(preparsed);
                handle.Dispose();
            }
        }

        static string FindDevicePath()
        {
            Guid hidGuid;
            Native.HidD_GetHidGuid(out hidGuid);

            IntPtr devInfo = Native.SetupDiGetClassDevs(
                ref hidGuid, null, IntPtr.Zero,
                Native.DIGCF_PRESENT | Native.DIGCF_DEVICEINTERFACE);
            if (devInfo == (IntPtr)(-1)) return null;

            try
            {
                Native.SP_DEVICE_INTERFACE_DATA di = new Native.SP_DEVICE_INTERFACE_DATA();
                di.cbSize = Marshal.SizeOf(typeof(Native.SP_DEVICE_INTERFACE_DATA));

                for (uint i = 0; Native.SetupDiEnumDeviceInterfaces(devInfo, IntPtr.Zero, ref hidGuid, i, ref di); i++)
                {
                    uint required = 0;
                    Native.SetupDiGetDeviceInterfaceDetail(devInfo, ref di, IntPtr.Zero, 0, out required, IntPtr.Zero);
                    if (required == 0) continue;

                    IntPtr buf = Marshal.AllocHGlobal((int)required);
                    try
                    {
                        Marshal.WriteInt32(buf, IntPtr.Size == 8 ? 8 : 6);

                        if (!Native.SetupDiGetDeviceInterfaceDetail(devInfo, ref di, buf, required, out required, IntPtr.Zero))
                            continue;

                        string path = Marshal.PtrToStringAuto(new IntPtr(buf.ToInt64() + 4));
                        if (string.IsNullOrEmpty(path)) continue;

                        if (MatchesDevice(path)) return path;
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(buf);
                    }
                }
            }
            finally
            {
                Native.SetupDiDestroyDeviceInfoList(devInfo);
            }
            return null;
        }

        static bool MatchesDevice(string path)
        {
            SafeFileHandle handle = Native.CreateFile(
                path, 0, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE,
                IntPtr.Zero, Native.OPEN_EXISTING, 0, IntPtr.Zero);
            if (handle.IsInvalid) return false;

            IntPtr preparsed = IntPtr.Zero;
            try
            {
                Native.HIDD_ATTRIBUTES attr = new Native.HIDD_ATTRIBUTES();
                attr.Size = (uint)Marshal.SizeOf(typeof(Native.HIDD_ATTRIBUTES));
                if (!Native.HidD_GetAttributes(handle, ref attr)) return false;
                if (attr.VendorID != VID || attr.ProductID != PID) return false;

                if (!Native.HidD_GetPreparsedData(handle, out preparsed)) return false;
                Native.HIDP_CAPS caps;
                if (Native.HidP_GetCaps(preparsed, out caps) != Native.HIDP_STATUS_SUCCESS) return false;

                return caps.UsagePage == USAGE_PAGE;
            }
            catch { return false; }
            finally
            {
                if (preparsed != IntPtr.Zero) Native.HidD_FreePreparsedData(preparsed);
                handle.Dispose();
            }
        }

        static bool WriteOverlapped(SafeFileHandle handle, byte[] data, int timeoutMs)
        {
            IntPtr evt = Native.CreateEvent(IntPtr.Zero, true, false, null);
            if (evt == IntPtr.Zero) return false;
            try
            {
                Native.OVERLAPPED ov = new Native.OVERLAPPED();
                ov.hEvent = evt;
                uint written;
                bool ok = Native.WriteFile(handle, data, (uint)data.Length, out written, ref ov);
                if (!ok)
                {
                    int err = Marshal.GetLastWin32Error();
                    if (err != Native.ERROR_IO_PENDING) return false;

                    uint wait = Native.WaitForSingleObject(evt, (uint)timeoutMs);
                    if (wait != 0)
                    {
                        Native.CancelIoEx(handle, IntPtr.Zero);
                        return false;
                    }
                    if (!Native.GetOverlappedResult(handle, ref ov, out written, false)) return false;
                }
                return written > 0;
            }
            finally
            {
                Native.CloseHandle(evt);
            }
        }

        static bool ReadOverlapped(SafeFileHandle handle, byte[] buffer, int timeoutMs, out int read)
        {
            read = 0;
            IntPtr evt = Native.CreateEvent(IntPtr.Zero, true, false, null);
            if (evt == IntPtr.Zero) return false;
            try
            {
                Native.OVERLAPPED ov = new Native.OVERLAPPED();
                ov.hEvent = evt;
                uint bytesRead;
                bool ok = Native.ReadFile(handle, buffer, (uint)buffer.Length, out bytesRead, ref ov);
                if (!ok)
                {
                    int err = Marshal.GetLastWin32Error();
                    if (err != Native.ERROR_IO_PENDING) return false;

                    uint wait = Native.WaitForSingleObject(evt, (uint)timeoutMs);
                    if (wait != 0)
                    {
                        Native.CancelIoEx(handle, IntPtr.Zero);
                        return false;
                    }
                    if (!Native.GetOverlappedResult(handle, ref ov, out bytesRead, false)) return false;
                }
                read = (int)bytesRead;
                return read > 0;
            }
            finally
            {
                Native.CloseHandle(evt);
            }
        }
    }

    internal static class Native
    {
        public const uint GENERIC_READ = 0x80000000;
        public const uint GENERIC_WRITE = 0x40000000;
        public const uint FILE_SHARE_READ = 0x1;
        public const uint FILE_SHARE_WRITE = 0x2;
        public const uint OPEN_EXISTING = 3;
        public const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        public const int ERROR_IO_PENDING = 997;
        public const int HIDP_STATUS_SUCCESS = 0x00110000;
        public const int DIGCF_PRESENT = 0x2;
        public const int DIGCF_DEVICEINTERFACE = 0x10;

        [StructLayout(LayoutKind.Sequential)]
        public struct HIDD_ATTRIBUTES
        {
            public uint Size;
            public ushort VendorID;
            public ushort ProductID;
            public ushort VersionNumber;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HIDP_CAPS
        {
            public ushort Usage;
            public ushort UsagePage;
            public ushort InputReportByteLength;
            public ushort OutputReportByteLength;
            public ushort FeatureReportByteLength;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)]
            public ushort[] Reserved;
            public ushort NumberLinkCollectionNodes;
            public ushort NumberInputButtonCaps;
            public ushort NumberInputValueCaps;
            public ushort NumberInputDataIndices;
            public ushort NumberOutputButtonCaps;
            public ushort NumberOutputValueCaps;
            public ushort NumberOutputDataIndices;
            public ushort NumberFeatureButtonCaps;
            public ushort NumberFeatureValueCaps;
            public ushort NumberFeatureDataIndices;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct SP_DEVICE_INTERFACE_DATA
        {
            public int cbSize;
            public Guid InterfaceClassGuid;
            public int Flags;
            public IntPtr Reserved;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct OVERLAPPED
        {
            public IntPtr Internal;
            public IntPtr InternalHigh;
            public uint Offset;
            public uint OffsetHigh;
            public IntPtr hEvent;
        }

        [DllImport("hid.dll")]
        public static extern void HidD_GetHidGuid(out Guid hidGuid);

        [DllImport("hid.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool HidD_GetAttributes(SafeFileHandle handle, ref HIDD_ATTRIBUTES attr);

        [DllImport("hid.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool HidD_GetPreparsedData(SafeFileHandle handle, out IntPtr preparsedData);

        [DllImport("hid.dll")]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool HidD_FreePreparsedData(IntPtr preparsedData);

        [DllImport("hid.dll")]
        public static extern int HidP_GetCaps(IntPtr preparsedData, out HIDP_CAPS caps);

        [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr SetupDiGetClassDevs(ref Guid classGuid, string enumerator, IntPtr hwndParent, int flags);

        [DllImport("setupapi.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool SetupDiEnumDeviceInterfaces(IntPtr devInfo, IntPtr devInfoData, ref Guid interfaceClassGuid, uint memberIndex, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData);

        [DllImport("setupapi.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr devInfo, ref SP_DEVICE_INTERFACE_DATA deviceInterfaceData, IntPtr deviceInterfaceDetailData, uint deviceInterfaceDetailDataSize, out uint requiredSize, IntPtr deviceInfoData);

        [DllImport("setupapi.dll")]
        public static extern int SetupDiDestroyDeviceInfoList(IntPtr devInfo);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(string filename, uint access, uint share, IntPtr securityAttributes, uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint numberOfBytesToRead, out uint numberOfBytesRead, ref OVERLAPPED overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint numberOfBytesToWrite, out uint numberOfBytesWritten, ref OVERLAPPED overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool GetOverlappedResult(SafeFileHandle handle, ref OVERLAPPED overlapped, out uint numberOfBytesTransferred, bool wait);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool CancelIoEx(SafeFileHandle handle, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        public static extern IntPtr CreateEvent(IntPtr securityAttributes, bool manualReset, bool initialState, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.U1)]
        public static extern bool DestroyIcon(IntPtr hIcon);
    }
}
