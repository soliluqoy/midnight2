// Standalone recovery: no Electron, agent, network, document or credential access. Mutation requires the native UI.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public static class MidnightRecovery {
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 131072 };
  static readonly string Self = Process.GetCurrentProcess().MainModule.FileName;
  static string Profile;
  static string Recovery { get { return Path.Combine(Profile, "recovery"); } }
  static string Plugins { get { return Path.Combine(Profile, "missions", "plugins"); } }
  static void Guard(string file) {
    string full = Path.GetFullPath(file);
    if (full.StartsWith(@"\\") || full.IndexOf(':', 2) >= 0) throw new InvalidOperationException("Choose a local Midnight data folder.");
    string cursor = full;
    while (!string.IsNullOrEmpty(cursor)) {
      if ((Directory.Exists(cursor) || File.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Recovery cannot follow linked data folders.");
      cursor = Path.GetDirectoryName(cursor);
    }
  }
  static Dictionary<string, object> Read(string file) {
    Guard(file); var info = new FileInfo(file);
    if (!info.Exists || info.Length > 131072) throw new InvalidOperationException("Recovery metadata is unavailable.");
    return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
  }
  static bool Registered() {
    try { string file = Path.Combine(Recovery, "app-id"); Guard(file); return new FileInfo(file).Length <= 64 && File.ReadAllText(file, Encoding.UTF8).Trim() == "app.midnight.capsule"; } catch { return false; }
  }
  static bool Running() {
    try {
      var owner = Read(Path.Combine(Recovery, "shell-owner.json"));
      if (Convert.ToInt32(owner["format"]) != 1) throw new InvalidOperationException();
      int pid = Convert.ToInt32(owner["pid"]); if (pid <= 0) throw new InvalidOperationException();
      try { using (var process = Process.GetProcessById(pid)) return !process.HasExited; } catch (ArgumentException) { return false; }
    } catch {
      int session = Process.GetCurrentProcess().SessionId;
      foreach (string name in new [] { "midnight", "electron" }) foreach (var process in Process.GetProcessesByName(name)) {
        using (process) { try { if (!process.HasExited && process.SessionId == session) return true; } catch { return true; } }
      }
      return false;
    }
  }
  static bool LeaseBusy() {
    string file = Path.Combine(Recovery, "operation.lock"); Guard(file);
    if (!File.Exists(file)) return false;
    try { using (var lease = new FileStream(file, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) return false; } catch (IOException) { return true; }
  }
  static void Stopped(bool checkLease = true) { if (Running() || (checkLease && LeaseBusy())) throw new InvalidOperationException("Close Midnight before restoring components."); }
  static void Save(string file, object value) {
    Guard(file); Directory.CreateDirectory(Path.GetDirectoryName(file)); string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
    byte[] bytes = Encoding.UTF8.GetBytes(json.Serialize(value));
    using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
    if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
  }
  static Dictionary<string, object> ArchivePlugins() {
    Guard(Profile); Guard(Plugins); Guard(Recovery);
    if (!Registered()) throw new InvalidOperationException("This folder has not been registered by Midnight.");
    Stopped(); Directory.CreateDirectory(Recovery);
    string operationLock = Path.Combine(Recovery, "operation.lock"); Guard(operationLock);
    using (var operation = new FileStream(operationLock, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
      Stopped(false);
      if (!Directory.Exists(Plugins)) return new Dictionary<string, object> { { "state", "already-restored" } };
      string id = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N");
      string relative = Path.Combine("recovery", "plugin-archives", id), destination = Path.GetFullPath(Path.Combine(Profile, relative));
      if (!destination.StartsWith(Profile.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The archive escaped this profile.");
      Guard(destination); Directory.CreateDirectory(Path.GetDirectoryName(destination));
      string intent = Path.Combine(Recovery, "intents", id + ".json");
      Save(intent, new { format = 1, id = id, state = "prepared", source = "missions/plugins", destination = relative, at = DateTime.UtcNow.ToString("o") });
      Directory.Move(Plugins, destination); // Same-profile rename; no recursive reads/deletes or state rollback.
      Save(intent, new { format = 1, id = id, state = "archived", source = "missions/plugins", destination = relative, at = DateTime.UtcNow.ToString("o") });
      return new Dictionary<string, object> { { "state", "archived" }, { "id", id }, { "archive", relative } };
    }
  }
  static object Inspect() {
    bool registered = Registered(), running = Running() || LeaseBusy(), components = false; string pointer = "missing";
    try { Guard(Plugins); components = Directory.Exists(Plugins); var state = Read(Path.Combine(Plugins, "active.json")); pointer = Convert.ToInt32(state["format"]) == 1 ? "present" : "unreadable"; } catch { if (File.Exists(Path.Combine(Plugins, "active.json"))) pointer = "unreadable"; }
    return new { format = 1, registered = registered, running = running, componentsPresent = components, activationMetadata = pointer, signedInstallerRecovery = ValidSignature(Self) };
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] sealed class TrustFile {
    public uint Size; [MarshalAs(UnmanagedType.LPWStr)] public string File; public IntPtr Handle, Subject;
    public TrustFile(string file) { Size = (uint)Marshal.SizeOf(typeof(TrustFile)); File = file; }
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] sealed class TrustData {
    public uint Size; public IntPtr Callback, Sip; public uint UI = 2, Revocation = 1, Choice = 1; public IntPtr File;
    public uint Action = 1; public IntPtr State, Url; public uint Flags = 0x1000 | 0x80 | 0x2000, Context = 1; public IntPtr Settings;
    public TrustData(IntPtr file) { Size = (uint)Marshal.SizeOf(typeof(TrustData)); File = file; }
  }
  [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)] static extern int WinVerifyTrust(IntPtr window, [MarshalAs(UnmanagedType.LPStruct)] Guid action, TrustData data);
  static bool ValidSignature(string file) {
    var value = new TrustFile(file); IntPtr native = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TrustFile))); var data = new TrustData(native);
    Guid action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
    try { Marshal.StructureToPtr(value, native, false); return WinVerifyTrust(new IntPtr(-1), action, data) == 0; }
    catch { return false; }
    finally { data.Action = 2; try { WinVerifyTrust(new IntPtr(-1), action, data); } catch {} Marshal.DestroyStructure(native, typeof(TrustFile)); Marshal.FreeHGlobal(native); }
  }
  static string Hash(Stream stream) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }
  static bool SamePublisher(string file) {
    if (!ValidSignature(Self) || !ValidSignature(file)) return false;
    try {
      using (var mine = new X509Certificate2(X509Certificate.CreateFromSignedFile(Self))) using (var theirs = new X509Certificate2(X509Certificate.CreateFromSignedFile(file))) {
        return mine.PublicKey.Oid.Value == theirs.PublicKey.Oid.Value && Convert.ToBase64String(mine.PublicKey.EncodedParameters.RawData) == Convert.ToBase64String(theirs.PublicKey.EncodedParameters.RawData) && Convert.ToBase64String(mine.PublicKey.EncodedKeyValue.RawData) == Convert.ToBase64String(theirs.PublicKey.EncodedKeyValue.RawData);
      }
    } catch { return false; }
  }
  static void CheckInstaller(string file) {
    Guard(file);
    if (!System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(file), @"^midnight-setup(?:-[a-zA-Z0-9._-]+)?\.exe$", System.Text.RegularExpressions.RegexOptions.IgnoreCase) || !string.Equals(FileVersionInfo.GetVersionInfo(file).ProductName, "midnight", StringComparison.OrdinalIgnoreCase) || !SamePublisher(file)) throw new InvalidOperationException("Choose a signed Midnight installer from this recovery helper's publisher.");
  }
  static void Show() {
    Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
    var form = new Form { Text = "Midnight recovery", Width = 550, Height = 330, StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false };
    var text = new Label { Left = 22, Top = 18, Width = 490, Height = 88, Text = "Restore Midnight's official components. Custom components are kept in an archive.\r\n\r\nYour documents, sign-ins, model files and edit receipts stay in place." };
    var status = new Label { Left = 22, Top = 194, Width = 490, Height = 75 };
    var restore = new Button { Left = 22, Top = 112, Width = 225, Height = 32, Text = "Restore official components", Enabled = Registered() };
    var installer = new Button { Left = 259, Top = 112, Width = 250, Height = 32, Text = "Choose cached installer" };
    var close = new Button { Left = 390, Top = 155, Width = 119, Height = 30, Text = "Close" };
    close.Click += (sender, args) => form.Close();
    restore.Click += (sender, args) => {
      try {
        if (MessageBox.Show(form, "Archive custom components for this Midnight data folder?\r\n\r\n" + Profile, "Restore official components", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
        var result = ArchivePlugins(); status.Text = "Components restored. Start Midnight again.";
        if (result.ContainsKey("archive")) status.Text += "\r\nYour component archive: " + Convert.ToString(result["archive"]);
      } catch (Exception error) { status.Text = error is IOException ? "Another operation is using these components. Close Midnight and try again." : error.Message; }
    };
    installer.Enabled = ValidSignature(Self);
    installer.Click += (sender, args) => {
      using (var choose = new OpenFileDialog { Title = "Choose a cached Midnight installer", Filter = "Midnight installer|midnight-setup*.exe", CheckFileExists = true }) {
        if (choose.ShowDialog(form) != DialogResult.OK) return;
        try {
          Stopped();
          Guard(Recovery); Directory.CreateDirectory(Recovery); string leaseFile = Path.Combine(Recovery, "operation.lock"); Guard(leaseFile);
          using (var recoveryLease = new FileStream(leaseFile, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) using (var locked = new FileStream(choose.FileName, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            Stopped(false);
            CheckInstaller(choose.FileName); string digest = Hash(locked);
            if (MessageBox.Show(form, "Run this verified local installer?\r\n\r\n" + Path.GetFileName(choose.FileName), "Repair Midnight", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;
            locked.Position = 0; if (Hash(locked) != digest) throw new InvalidOperationException("The selected installer changed.");
            Process.Start(new ProcessStartInfo(choose.FileName) { UseShellExecute = false }); status.Text = "The verified installer is running.";
          }
        } catch { status.Text = "The installer could not be verified or launched. Use a signed Midnight installer from this publisher."; }
      }
    };
    status.Text = !Registered() ? "This Midnight data folder is not registered." : Running() || LeaseBusy() ? "Close Midnight before restoring components." : installer.Enabled ? "Recovery works without AI or a network connection." : "Component recovery is available. Verified installer recovery needs a signed build.";
    form.Controls.AddRange(new Control[] { text, restore, installer, close, status }); Application.Run(form);
  }
  [STAThread] public static int Main(string[] args) {
    try { Console.OutputEncoding = new UTF8Encoding(false); } catch {} // A GUI launch has no console.
    try {
      string mode = "ui"; Profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "midnight");
      for (int i = 0; i < args.Length; i++) {
        if (args[i] == "--profile" && i + 1 < args.Length) Profile = args[++i];
        else if (args[i] == "--inspect") mode = "inspect";
#if MIDNIGHT_RECOVERY_FIXTURES
        else if (args[i] == "--fixture-reset") mode = "fixture-reset";
        else if (args[i] == "--fixture-signature") mode = "fixture-signature";
#endif
        else throw new InvalidOperationException("Unsupported recovery request.");
      }
      Profile = Path.GetFullPath(Profile);
      if (Profile == Path.GetPathRoot(Profile)) throw new InvalidOperationException("Choose Midnight's data folder, not a drive root.");
      Profile = Profile.TrimEnd(Path.DirectorySeparatorChar); Guard(Profile);
      if (mode == "inspect") { Console.WriteLine(json.Serialize(Inspect())); return 0; }
#if MIDNIGHT_RECOVERY_FIXTURES
      if (mode.StartsWith("fixture-")) {
        string parent = Path.GetDirectoryName(Profile);
        if (Path.GetDirectoryName(parent) != Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar) || !Path.GetFileName(parent).StartsWith("midnight-recovery-fixtures-") || Path.GetFileName(Profile) != "profile") throw new InvalidOperationException("Fixture mutation requires its own disposable profile.");
        if (mode == "fixture-reset") Console.WriteLine(json.Serialize(ArchivePlugins()));
        else Console.WriteLine(json.Serialize(new { trusted = SamePublisher(Self) }));
        return 0;
      }
#endif
      Show(); return 0;
    } catch (Exception error) { Console.WriteLine(json.Serialize(new { ok = false, error = error is IOException ? "Recovery is busy or cannot access this profile." : error.Message })); return 1; }
  }
}
