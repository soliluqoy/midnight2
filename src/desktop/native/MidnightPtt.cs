// Hold Ctrl+Alt+Shift+Space. Only emits DOWN with original window identity, UP or CANCEL; no text/key log.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class PttChord {
  readonly HashSet<int> held = new HashSet<int>();
  bool active, blocked, swallowed;
  static bool Ctrl(int k) { return k == 0x11 || k == 0xA2 || k == 0xA3; }
  static bool Alt(int k) { return k == 0x12 || k == 0xA4 || k == 0xA5; }
  static bool Shift(int k) { return k == 0x10 || k == 0xA0 || k == 0xA1; }
  static bool Required(int k) { return Ctrl(k) || Alt(k) || Shift(k) || k == 0x20; }
  bool Has(Predicate<int> test) { foreach (int k in held) if (test(k)) return true; return false; }
  bool Combo { get { return Has(Ctrl) && Has(Alt) && Has(Shift) && held.Contains(0x20); } }
  // Flags: 1 begin, 2 end, 4 cancel, 8 consume the invocation Space (never consume modifier releases).
  public int Feed(int key, bool down) {
    bool was = active; int result = 0;
    if (down) held.Add(key); else held.Remove(key);
    if (down && !Required(key)) { blocked = true; if (active) { active = false; result |= 4; } }
    if (!active && down && key == 0x20 && Combo && !blocked && !Has(k => !Required(k))) { active = true; swallowed = true; result |= 1; }
    if (was && active && !Combo) { active = false; blocked = true; result |= 2; }
    if (key == 0x20 && swallowed) { result |= 8; if (!down) swallowed = false; }
    if (!Has(Required)) blocked = false;
    return result;
  }
  public bool Reset(IEnumerable<int> currentlyHeld) { bool was = active; active = false; swallowed = false; held.Clear(); foreach (int k in currentlyHeld) held.Add(k); blocked = held.Count > 0; return was; }
}
public static class Program {
  delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  static readonly HookProc callback = Key;
  static readonly PttChord chord = new PttChord(); static readonly object gate = new object(); static IntPtr hook;
  [StructLayout(LayoutKind.Sequential)] struct KeyData { public uint vk, scan, flags, time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  static void Emit(string value) { Console.WriteLine(value); Console.Out.Flush(); }
  static IEnumerable<int> Held() { foreach (int k in new [] { 0xA2, 0xA3, 0xA4, 0xA5, 0xA0, 0xA1, 0x20 }) if ((GetAsyncKeyState(k) & 0x8000) != 0) yield return k; }
  static IntPtr Key(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      int msg = message.ToInt32();
      if (msg == 0x100 || msg == 0x104 || msg == 0x101 || msg == 0x105) {
        KeyData key = (KeyData)Marshal.PtrToStructure(data, typeof(KeyData));
        if ((key.flags & 0x10) == 0) {
          int result; lock(gate) result = chord.Feed((int)key.vk, msg == 0x100 || msg == 0x104);
          if ((result & 1) != 0) { IntPtr window = GetAncestor(GetForegroundWindow(), 2); uint pid; GetWindowThreadProcessId(window, out pid); Emit("DOWN " + window.ToInt64() + " " + pid); }
          if ((result & 2) != 0) Emit("UP"); if ((result & 4) != 0) Emit("CANCEL");
          if ((result & 8) != 0) return new IntPtr(1);
        }
      }
    }
    return CallNextHookEx(hook, code, message, data);
  }
  static void Test() {
    var c = new PttChord(); c.Feed(0xA2, true); c.Feed(0xA4, true); c.Feed(0xA0, true);
    if (c.Feed(0x20, true) != 9 || c.Feed(0x20, true) != 8 || c.Feed(0x20, false) != 10) throw new Exception("PTT repeat/release");
    c.Feed(0xA2, false); c.Feed(0xA4, false); c.Feed(0xA0, false);
    c = new PttChord(); c.Feed(0xA1, true); c.Feed(0xA5, true); c.Feed(0xA3, true); c.Feed(0x20, true);
    if (c.Feed(0xA5, false) != 2 || c.Feed(0x20, false) != 8) throw new Exception("PTT right modifiers/release");
    c = new PttChord(); c.Feed(0xA2, true); c.Feed(0xA4, true);
    if (c.Feed(0x20, true) != 0 || c.Feed(0x20, false) != 0) throw new Exception("Typed quick shortcut must pass through");
    c = new PttChord(); c.Feed(0xA2, true); c.Feed(0xA4, true); c.Feed(0xA0, true); c.Feed(0x20, true);
    if (c.Feed(0x41, true) != 4 || c.Feed(0x20, false) != 8) throw new Exception("Other shortcut cancels");
    c = new PttChord(); c.Reset(new [] { 0xA2, 0xA4, 0xA0 });
    if (c.Feed(0x20, true) != 0) throw new Exception("Restart while held must not start");
    c = new PttChord(); c.Feed(0xA2, true); c.Feed(0xA4, true); c.Feed(0xA0, true); c.Feed(0x20, true);
    if (!c.Reset(new int[0]) || c.Feed(0x20, false) != 0) throw new Exception("Reset cancels old press");
    Emit("PASS PTT press/release, repeats, modifier order, typed shortcut isolation, cancellation and reset");
  }
  [STAThread] public static int Main(string[] args) {
    if (Array.IndexOf(args, "--self-test") >= 0) { Test(); return 0; }
    int parent = 0, index = Array.IndexOf(args, "--parent-pid"); if (index >= 0 && index + 1 < args.Length) int.TryParse(args[index + 1], out parent);
    try {
      lock(gate) chord.Reset(Held()); hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0); if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      var reader = new System.Threading.Thread(delegate() { string line; while ((line = Console.ReadLine()) != null) if (line == "RESET") { bool cancelled; lock(gate) cancelled = chord.Reset(Held()); if (cancelled) Emit("CANCEL"); } Environment.Exit(0); }); reader.IsBackground = true; reader.Start();
      using (var timer = new System.Threading.Timer(delegate(object unused) { if (parent <= 0) return; try { if (!Process.GetProcessById(parent).HasExited) return; } catch {} Environment.Exit(0); }, null, 2000, 2000)) { Emit("READY"); Application.Run(); }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
    finally { if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook); }
  }
}
