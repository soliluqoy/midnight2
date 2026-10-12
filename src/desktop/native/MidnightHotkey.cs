// Ctrl+Win listener for midnight on Windows. Built into midnight-hotkey.exe by scripts/build-native.mjs with the C#
// compiler that ships with Windows (.NET Framework 4); hotkey-helper.ps1 loads this same file only when the exe is
// missing (a development checkout that has not run the build). Only emits READY / TRIGGER on stdout: no key contents
// are stored or transmitted, no elevation, no third-party code.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class ModifierChord {
  readonly HashSet<int> held = new HashSet<int>();
  bool candidate, blocked;
  static bool Ctrl(int k) { return k == 0x11 || k == 0xA2 || k == 0xA3; }
  static bool Win(int k) { return k == 0x5B || k == 0x5C; }
  bool ControlHeld { get { foreach (int k in held) if (Ctrl(k)) return true; return false; } }
  bool WindowsHeld { get { return held.Contains(0x5B) || held.Contains(0x5C); } }
  bool OtherHeld { get { foreach (int k in held) if (!Ctrl(k) && !Win(k)) return true; return false; } }

  // Return flags: 1 = summon on release, 2 = mask the Start menu when the two-key chord first forms.
  // Wait for release, so Ctrl+Win+Arrow and other existing system shortcuts pass through untouched.
  public int Feed(int key, bool down) {
    bool before = ControlHeld && WindowsHeld;
    bool mask = false;
    if (down) held.Add(key); else held.Remove(key);
    bool combo = ControlHeld && WindowsHeld;
    if (down && !Ctrl(key) && !Win(key) && (ControlHeld || WindowsHeld)) {
      blocked = true; candidate = false;
    }
    if (!before && combo) {
      if (OtherHeld) blocked = true;
      candidate = !blocked;
      mask = candidate;
    }
    bool trigger = before && !combo && candidate;
    if (trigger) { candidate = false; blocked = true; }
    if (!ControlHeld && !WindowsHeld) { blocked = false; candidate = false; }
    return (trigger ? 1 : 0) | (mask ? 2 : 0);
  }
}

public static class MidnightHotkey {
  delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  static readonly HookProc callback = OnKey; // keep the delegate alive for the lifetime of the hook
  static readonly ModifierChord chord = new ModifierChord();
  static IntPtr hook;
  static int parentProcess;
  [StructLayout(LayoutKind.Sequential)] struct KeyData { public uint vk, scan, flags, time; public UIntPtr extra; }
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr handle);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr handle, int code, IntPtr message, IntPtr data);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint processId);
  [StructLayout(LayoutKind.Sequential)] struct KeyboardInput { public ushort vk, scan; public uint flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int x, y; public uint data, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard; [FieldOffset(0)] public MouseInput mouse; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
  [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);

  static void MaskStartMenu() {
    // An unassigned, non-text key marks the Win gesture as used, without activating an app/system shortcut.
    // Mask on chord formation, while Win is still held. Always pass real key-ups through to avoid stuck modifiers.
    Input down = new Input(); down.type = 1; down.data.keyboard.vk = 0xE8;
    Input up = down; up.data.keyboard.flags = 2;
    SendInput(2, new Input[] { down, up }, Marshal.SizeOf(typeof(Input)));
  }

  static IntPtr OnKey(int code, IntPtr message, IntPtr data) {
    if (code >= 0) {
      int msg = message.ToInt32();
      if (msg == 0x100 || msg == 0x104 || msg == 0x101 || msg == 0x105) {
        KeyData k = (KeyData)Marshal.PtrToStructure(data, typeof(KeyData));
        if ((k.flags & 0x10) == 0) { // ignore synthetic input, including midnight's computer-use keystrokes
          int result = chord.Feed((int)k.vk, msg == 0x100 || msg == 0x104);
          if ((result & 1) != 0) {
            if (parentProcess > 0) AllowSetForegroundWindow((uint)parentProcess);
            Console.WriteLine("TRIGGER"); Console.Out.Flush();
          }
          if ((result & 2) != 0) MaskStartMenu();
        }
      }
    }
    return CallNextHookEx(hook, code, message, data);
  }

  public static void Run(int parentPid) {
    parentProcess = parentPid;
    hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    // Don't leave a hook behind if Electron crashes or is force-quit.
    System.Threading.Timer parent = new System.Threading.Timer(delegate(object unused) {
      if (parentPid <= 0) return;
      try { if (!Process.GetProcessById(parentPid).HasExited) return; } catch { }
      Environment.Exit(0);
    }, null, 2000, 2000);
    try { Console.WriteLine("READY"); Console.Out.Flush(); Application.Run(); }
    finally { parent.Dispose(); UnhookWindowsHookEx(hook); }
  }

  public static void Test() {
    int c = 0xA2, w = 0x5B;
    ModifierChord s = new ModifierChord();
    if (s.Feed(c, true) != 0 || s.Feed(w, true) != 2 || s.Feed(w, true) != 0 || s.Feed(w, false) != 1 || s.Feed(c, false) != 0) throw new Exception("Ctrl then Win / repeat");
    s = new ModifierChord();
    if (s.Feed(w, true) != 0 || s.Feed(c, true) != 2 || s.Feed(c, false) != 1 || s.Feed(w, false) != 0) throw new Exception("Win then Ctrl");
    s = new ModifierChord(); s.Feed(c, true); s.Feed(w, true); s.Feed(0x27, true); s.Feed(0x27, false);
    if (s.Feed(w, false) != 0 || s.Feed(c, false) != 0) throw new Exception("System shortcut must pass through");
    s = new ModifierChord(); s.Feed(0xA4, true); s.Feed(c, true); s.Feed(w, true);
    if (s.Feed(w, false) != 0 || s.Feed(c, false) != 0) throw new Exception("Extra modifiers must not summon");
    s = new ModifierChord(); s.Feed(0xA3, true); s.Feed(0x5C, true);
    if (s.Feed(0xA3, false) != 1 || s.Feed(0x5C, false) != 0) throw new Exception("Right-hand modifiers");
    s = new ModifierChord(); s.Feed(w, true);
    if (s.Feed(w, false) != 0) throw new Exception("Win alone must pass through");
    Console.WriteLine("PASS modifier-only chord, repeats, both key orders, system shortcuts, extra modifiers, right-hand keys, Win alone");
  }
}

public static class Program {
  [STAThread]
  public static int Main(string[] args) {
    try {
      if (Array.IndexOf(args, "--self-test") >= 0) { MidnightHotkey.Test(); return 0; }
      int parent = 0;
      int i = Array.IndexOf(args, "--parent-pid");
      if (i >= 0 && i + 1 < args.Length) int.TryParse(args[i + 1], out parent);
      MidnightHotkey.Run(parent);
      return 0;
    } catch (Exception e) {
      Console.Error.WriteLine(e.Message);
      return 1;
    }
  }
}
