using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Spokeline;

/// A system-wide key combination with press and release (hold to talk), via a low-level keyboard hook.
/// "ctrl+option+v" means Ctrl+Alt+V on Windows ("option" = Alt, "cmd" = Windows key).
///
/// The hook lives on its own thread: Windows gives it about a second per key press, and quietly removes
/// it for good if it is slower. The main thread can be busy for longer (loading the speech models), so the
/// hook only notes the press and hands it to the main thread.
sealed class HotKey : IDisposable
{
    public event Action? Down;
    public event Action? Up;
    public string Display { get; private set; } = "";

    volatile int key;
    volatile bool ctrl, alt, shift, win;
    volatile bool held;
    IntPtr hook;
    readonly LowLevelKeyboardProc proc;
    readonly SynchronizationContext ui;
    Thread? thread;
    uint threadId;

    public HotKey(SynchronizationContext ui) { this.ui = ui; proc = Callback; }

    public bool Set(string text)
    {
        int k = 0; bool c = false, a = false, s = false, w = false;
        foreach (var raw in text.ToLowerInvariant().Split(new[] { '+', '-', ' ' }, StringSplitOptions.RemoveEmptyEntries))
        {
            switch (raw)
            {
                case "ctrl": case "control": c = true; break;
                case "alt": case "opt": case "option": a = true; break;
                case "shift": s = true; break;
                case "cmd": case "command": case "win": case "windows": w = true; break;
                default: k = KeyCode(raw); if (k == 0) { key = 0; Display = ""; return false; } break;
            }
        }
        key = 0; held = false;
        if (k == 0 || !(c || a || w)) { Display = ""; return false; }
        ctrl = c; alt = a; shift = s; win = w;
        Display = (c ? "Ctrl+" : "") + (a ? "Alt+" : "") + (s ? "Shift+" : "") + (w ? "Win+" : "") + (k == 0x20 ? "Space" : ((System.Windows.Forms.Keys)k).ToString());
        key = k;
        return EnsureHook();
    }

    /// Starts the hook thread once; it stays until Dispose. With no key set, it lets every key pass.
    bool EnsureHook()
    {
        if (thread != null) return hook != IntPtr.Zero;
        var ready = new ManualResetEventSlim();
        thread = new Thread(() =>
        {
            threadId = GetCurrentThreadId();
            using (var p = Process.GetCurrentProcess())
            using (var m = p.MainModule!)
                hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, proc, GetModuleHandle(m.ModuleName), 0);
            ready.Set();
            if (hook == IntPtr.Zero) return;
            // The hook is called while this thread waits for messages; WM_QUIT (from Dispose) ends it.
            while (GetMessage(out _, IntPtr.Zero, 0, 0) > 0) { }
            UnhookWindowsHookEx(hook);
            hook = IntPtr.Zero;
        }) { IsBackground = true, Name = "hotkey", Priority = ThreadPriority.AboveNormal };
        thread.Start();
        ready.Wait(3000);
        if (hook == IntPtr.Zero) { thread = null; Log.Write("push-to-talk key: Windows refused the keyboard hook"); }
        return hook != IntPtr.Zero;
    }

    static int KeyCode(string k)
    {
        if (k == "space") return 0x20;
        if (k is "return" or "enter") return 0x0D;
        if (k.Length == 1 && char.IsLetterOrDigit(k[0])) return char.ToUpperInvariant(k[0]);
        if (k.StartsWith("f") && int.TryParse(k[1..], out var f) && f is >= 1 and <= 12) return 0x6F + f;
        return 0;
    }

    // Runs on the hook thread: decide quickly, hand the work to the main thread, return at once.
    IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        var k = key;
        if (nCode >= 0 && k != 0)
        {
            var vk = Marshal.ReadInt32(lParam);
            var msg = (int)wParam;
            var isDown = msg is 0x0100 or 0x0104; // WM_KEYDOWN, WM_SYSKEYDOWN
            var isUp = msg is 0x0101 or 0x0105;   // WM_KEYUP, WM_SYSKEYUP
            if (vk == k)
            {
                if (isDown && !held && Mods()) { held = true; ui.Post(_ => Down?.Invoke(), null); return (IntPtr)1; }
                if (isUp && held) { held = false; ui.Post(_ => Up?.Invoke(), null); return (IntPtr)1; }
                if (held) return (IntPtr)1; // swallow key repeats while held
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    bool Mods()
    {
        static bool Pressed(int vk) => (GetAsyncKeyState(vk) & 0x8000) != 0;
        return Pressed(0x11) == ctrl && Pressed(0x12) == alt && Pressed(0x10) == shift && (Pressed(0x5B) || Pressed(0x5C)) == win;
    }

    public void Dispose()
    {
        key = 0;
        if (thread != null && threadId != 0) PostThreadMessage(threadId, 0x0012 /* WM_QUIT */, IntPtr.Zero, IntPtr.Zero);
        thread?.Join(1000);
        thread = null;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public int x, y; public uint lPrivate; }

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string lpModuleName);
}
