using System.Runtime.InteropServices;

namespace Spokeline;

/// The microphone with Windows' own echo removal (the "Voice Capture DSP" that Teams and Skype use):
/// it takes the computer's sound out of the microphone, so Spokeline does not hear its own voice and you
/// can interrupt it without headphones. Delivers 16 kHz mono 16-bit sound, like NAudio's WaveInEvent.
/// If Windows refuses it, Start() returns false and the plain microphone is used instead.
sealed class EchoCapture : IDisposable
{
    public event Action<byte[], int>? DataAvailable;
    public event Action<string>? Failed;

    Thread? thread;
    volatile bool running;
    // Windows' echo remover only works while something is playing on the speakers (Microsoft: "if there is
    // no active render stream on the selected speaker device, the DMO will fail to process"). So while
    // it runs, Spokeline plays silence on the default speakers, the same ones its voice uses.
    NAudio.Wave.WaveOutEvent? silence;

    public bool Start()
    {
        var started = new ManualResetEventSlim();
        string? error = null;
        try
        {
            silence = new NAudio.Wave.WaveOutEvent();
            silence.Init(new NAudio.Wave.SilenceProvider(new NAudio.Wave.WaveFormat(16000, 16, 1)));
            silence.Play();
        }
        catch (Exception e) { Log.Write("echo removal: could not play silence: " + e.Message); }
        running = true;
        thread = new Thread(() => Run(started, e => error = e)) { IsBackground = true, Name = "echo capture" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        started.Wait(TimeSpan.FromSeconds(5));
        if (error != null || !started.IsSet) { running = false; StopSilence(); Log.Write("echo removal not available: " + (error ?? "no answer")); return false; }
        Log.Write("echo removal on" + deviceNames);
        return true;
    }

    void Run(ManualResetEventSlim started, Action<string> fail)
    {
        IMediaObject? dmo = null;
        var format = IntPtr.Zero;
        var buffer = new MediaBuffer(16000 * 2); // one second of sound
        // The "output buffer" record is handed to Windows as plain memory (pointer to the buffer, status,
        // two times: 32 bytes). Letting .NET convert it failed on a real PC (error 0x80131165).
        var comBuffer = IntPtr.Zero;
        var record = IntPtr.Zero;
        try
        {
            dmo = (IMediaObject)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("745057c7-f353-4f2d-a7ee-58434477730e"))!)!;
            var props = (IPropertyStore)dmo;
            // One microphone, echo removal against what the speakers play.
            var mode = new PropertyKey(new Guid("6f52c567-0360-4bd2-9617-ccbf1421c939"), 2);
            var value = PropVariant.FromInt(0); // SINGLE_CHANNEL_AEC
            Check(props.SetValue(ref mode, ref value), "set the echo mode");
            // Use Windows' default microphone and default speakers: the ones the plain microphone and
            // Spokeline's voice use. Left alone, Windows picks its "communications" devices instead (often a
            // headset lying on the desk), so it listened to the wrong microphone and lost the speakers.
            if (DefaultDevices() is { } indexes)
            {
                var devices = new PropertyKey(new Guid("6f52c567-0360-4bd2-9617-ccbf1421c939"), 4);
                var which = PropVariant.FromInt(indexes);
                Check(props.SetValue(ref devices, ref which), "choose the microphone and speakers");
            }

            format = Marshal.AllocCoTaskMem(18);
            var wf = new WaveFormatEx { wFormatTag = 1, nChannels = 1, nSamplesPerSec = 16000, nAvgBytesPerSec = 32000, nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0 };
            Marshal.StructureToPtr(wf, format, false);
            var mt = new DmoMediaType
            {
                majortype = new Guid("73647561-0000-0010-8000-00AA00389B71"), // audio
                subtype = new Guid("00000001-0000-0010-8000-00AA00389B71"),   // PCM
                bFixedSizeSamples = 1,
                lSampleSize = 2,
                formattype = new Guid("05589f81-c356-11ce-bf01-00aa0055595a"), // WAVEFORMATEX
                cbFormat = 18,
                pbFormat = format,
            };
            Check(dmo.SetOutputType(0, ref mt, 0), "set the sound format");
            Check(dmo.AllocateStreamingResources(), "start");
            started.Set();

            comBuffer = Marshal.GetComInterfaceForObject(buffer, typeof(IMediaBuffer));
            record = Marshal.AllocCoTaskMem(32);
            var failingSince = DateTime.MinValue;
            while (running)
            {
                Thread.Sleep(10);
                while (running)
                {
                    buffer.SetLength(0);
                    Marshal.WriteIntPtr(record, 0, comBuffer);
                    Marshal.WriteInt64(record, 8, 0);
                    Marshal.WriteInt64(record, 16, 0);
                    Marshal.WriteInt64(record, 24, 0);
                    var hr = dmo.ProcessOutput(0, 1, record, out _);
                    if (hr < 0)
                    {
                        // A short hiccup (for example the speakers were just switched) is waited out, like
                        // Chrome does; only if it keeps failing for 3 seconds is the plain microphone used.
                        if (failingSince == DateTime.MinValue) { failingSince = DateTime.Now; Log.Write("echo removal hiccup, code 0x" + hr.ToString("X8")); }
                        else if ((DateTime.Now - failingSince).TotalSeconds > 3) throw new COMException("echo removal stopped (code 0x" + hr.ToString("X8") + ")", hr);
                        break;
                    }
                    failingSince = DateTime.MinValue;
                    var n = buffer.Length;
                    if (n > 0) DataAvailable?.Invoke(buffer.Copy(), n);
                    if ((Marshal.ReadInt32(record, 8) & 0x01000000) == 0) break; // nothing more waiting right now
                }
            }
        }
        catch (Exception e)
        {
            if (!started.IsSet) { fail(e.Message); started.Set(); }
            else if (running) { Log.Write("echo removal failed: " + e.GetType().Name + ": " + e.Message); Failed?.Invoke(e.Message); }
        }
        finally
        {
            try { dmo?.FreeStreamingResources(); } catch { }
            if (dmo != null) Marshal.ReleaseComObject(dmo);
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            if (record != IntPtr.Zero) Marshal.FreeCoTaskMem(record);
            if (comBuffer != IntPtr.Zero) Marshal.Release(comBuffer);
            buffer.Dispose();
        }
    }

    string deviceNames = "";

    /// The places of the default speakers and the default microphone in Windows' lists of active devices,
    /// packed as the echo remover wants them (speakers in the upper half, microphone in the lower half).
    int? DefaultDevices()
    {
        try
        {
            using var all = new NAudio.CoreAudioApi.MMDeviceEnumerator();
            // The devices chosen in the /spokeline menu (by name), else the Windows defaults.
            var config = EarsConfig.Load();
            int Find(NAudio.CoreAudioApi.DataFlow flow, string wanted, out string name)
            {
                var list = all.EnumerateAudioEndPoints(flow, NAudio.CoreAudioApi.DeviceState.Active);
                if (wanted.Length > 0)
                    for (var i = 0; i < list.Count; i++) if (list[i].FriendlyName == wanted) { name = wanted; return i; }
                using var chosen = all.GetDefaultAudioEndpoint(flow, NAudio.CoreAudioApi.Role.Console);
                name = chosen.FriendlyName;
                for (var i = 0; i < list.Count; i++) if (list[i].ID == chosen.ID) return i;
                return -1;
            }
            var speakers = Find(NAudio.CoreAudioApi.DataFlow.Render, config.Speakers, out var speakerName);
            var microphone = Find(NAudio.CoreAudioApi.DataFlow.Capture, config.Microphone, out var microphoneName);
            if (speakers < 0 || microphone < 0) return null;
            deviceNames = $" (microphone: {microphoneName}; speakers: {speakerName})";
            return (speakers << 16) | microphone;
        }
        catch (Exception e) { Log.Write("echo removal: could not read the default devices: " + e.Message); return null; }
    }

    static void Check(int hr, string what) { if (hr < 0) throw new COMException("could not " + what, hr); }

    void StopSilence()
    {
        try { silence?.Stop(); silence?.Dispose(); } catch { }
        silence = null;
    }

    public void Dispose()
    {
        running = false;
        thread?.Join(1000);
        StopSilence();
    }

    // ------------------------------------------------------------ Windows interfaces

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WaveFormatEx
    {
        public short wFormatTag, nChannels;
        public int nSamplesPerSec, nAvgBytesPerSec;
        public short nBlockAlign, wBitsPerSample, cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct DmoMediaType
    {
        public Guid majortype, subtype;
        public int bFixedSizeSamples, bTemporalCompression, lSampleSize;
        public Guid formattype;
        public IntPtr pUnk;
        public int cbFormat;
        public IntPtr pbFormat;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PropertyKey
    {
        public Guid fmtid;
        public int pid;
        public PropertyKey(Guid f, int p) { fmtid = f; pid = p; }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PropVariant
    {
        [FieldOffset(0)] public short vt;
        [FieldOffset(8)] public int intValue;
        public static PropVariant FromInt(int v) => new() { vt = 3, intValue = v }; // VT_I4
    }

    [ComImport, Guid("d8ad0f58-5494-4102-97c5-ec798e59bcf4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMediaObject
    {
        [PreserveSig] int GetStreamCount(out int inputs, out int outputs);
        [PreserveSig] int GetInputStreamInfo(int index, out int flags);
        [PreserveSig] int GetOutputStreamInfo(int index, out int flags);
        [PreserveSig] int GetInputType(int index, int typeIndex, IntPtr type);
        [PreserveSig] int GetOutputType(int index, int typeIndex, IntPtr type);
        [PreserveSig] int SetInputType(int index, IntPtr type, int flags);
        [PreserveSig] int SetOutputType(int index, ref DmoMediaType type, int flags);
        [PreserveSig] int GetInputCurrentType(int index, IntPtr type);
        [PreserveSig] int GetOutputCurrentType(int index, IntPtr type);
        [PreserveSig] int GetInputSizeInfo(int index, out int size, out int lookahead, out int alignment);
        [PreserveSig] int GetOutputSizeInfo(int index, out int size, out int alignment);
        [PreserveSig] int GetInputMaxLatency(int index, out long latency);
        [PreserveSig] int SetInputMaxLatency(int index, long latency);
        [PreserveSig] int Flush();
        [PreserveSig] int Discontinuity(int index);
        [PreserveSig] int AllocateStreamingResources();
        [PreserveSig] int FreeStreamingResources();
        [PreserveSig] int GetInputStatus(int index, out int flags);
        [PreserveSig] int ProcessInput(int index, IMediaBuffer buffer, int flags, long time, long length);
        [PreserveSig] int ProcessOutput(int flags, int count, IntPtr buffers, out int status);
        [PreserveSig] int Lock(int lockIt);
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }
}

[ComImport, Guid("59eff8b9-938c-4a26-82f2-95cb84cdc837"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMediaBuffer
{
    [PreserveSig] int SetLength(int length);
    [PreserveSig] int GetMaxLength(out int length);
    [PreserveSig] int GetBufferAndLength(out IntPtr buffer, out int length);
}

/// The memory the echo canceller writes the cleaned sound into.
[ComVisible(true)]
public sealed class MediaBuffer : IMediaBuffer, IDisposable
{
    readonly IntPtr data;
    readonly int max;
    public int Length { get; private set; }
    public MediaBuffer(int size) { max = size; data = Marshal.AllocCoTaskMem(size); }
    public int SetLength(int length) { if (length < 0 || length > max) return unchecked((int)0x80070057); Length = length; return 0; }
    public int GetMaxLength(out int length) { length = max; return 0; }
    public int GetBufferAndLength(out IntPtr buffer, out int length) { buffer = data; length = Length; return 0; }
    public byte[] Copy() { var b = new byte[Length]; Marshal.Copy(data, b, 0, Length); return b; }
    public void Dispose() => Marshal.FreeCoTaskMem(data);
}

/// Reads the sound devices Windows has switched on (kept out of Shared.cs, which the tests build without NAudio).
static class Devices
{
    public static DeviceList? Read()
    {
        try
        {
            using var all = new NAudio.CoreAudioApi.MMDeviceEnumerator();
            string[] Names(NAudio.CoreAudioApi.DataFlow flow)
            {
                var list = all.EnumerateAudioEndPoints(flow, NAudio.CoreAudioApi.DeviceState.Active);
                return Enumerable.Range(0, list.Count).Select(i => list[i].FriendlyName).Distinct().ToArray();
            }
            string Default(NAudio.CoreAudioApi.DataFlow flow)
            {
                try { using var d = all.GetDefaultAudioEndpoint(flow, NAudio.CoreAudioApi.Role.Console); return d.FriendlyName; } catch { return ""; }
            }
            return new DeviceList(Names(NAudio.CoreAudioApi.DataFlow.Capture), Names(NAudio.CoreAudioApi.DataFlow.Render),
                Default(NAudio.CoreAudioApi.DataFlow.Capture), Default(NAudio.CoreAudioApi.DataFlow.Render));
        }
        catch { return null; }
    }
}
