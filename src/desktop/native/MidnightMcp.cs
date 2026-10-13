// midnight-mcp.exe: the stdio entry point MCP clients (Windows agent connectors, Claude Desktop, other apps) launch.
// It relays JSON-RPC lines between stdin/stdout and the running midnight over a per-user named pipe, after
// presenting the token midnight keeps in its app-data folder. If midnight is not running, it starts the installed
// app and waits for it. It understands nothing of MCP itself. Built by scripts/build-native.mjs.
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;

public static class MidnightMcp {
  static string PipeName() {
    var custom = Environment.GetEnvironmentVariable("MIDNIGHT_MCP_PIPE");
    if (!string.IsNullOrEmpty(custom)) return custom;
    var user = new StringBuilder();
    foreach (char c in Environment.UserName) user.Append(char.IsLetterOrDigit(c) || c == '.' || c == '-' || c == '_' ? c : '_');
    return "midnight-mcp-" + user;
  }

  static string TokenFile() {
    var custom = Environment.GetEnvironmentVariable("MIDNIGHT_MCP_TOKEN_FILE");
    if (!string.IsNullOrEmpty(custom)) return custom;
    return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "midnight", "mcp-token");
  }

  // The installed app is a few folders up: midnight\resources\app.asar.unpacked\src\desktop\native\midnight-mcp.exe
  static string FindApp() {
    var dir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
    for (int i = 0; i < 7 && dir != null; i++, dir = Path.GetDirectoryName(dir)) {
      var exe = Path.Combine(dir, "midnight.exe");
      if (File.Exists(exe)) return exe;
    }
    return null;
  }

  static NamedPipeClientStream Connect(string name) {
    var started = false;
    var deadline = DateTime.UtcNow.AddSeconds(40);
    while (true) {
      var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous);
      try { pipe.Connect(1500); return pipe; }
      catch (Exception) {
        pipe.Dispose();
        if (DateTime.UtcNow > deadline) throw new TimeoutException("midnight did not answer. Open midnight and turn on Settings > Connectors > Let other apps use midnight.");
        if (!started) {
          started = true;
          var app = FindApp();
          if (app != null && Environment.GetEnvironmentVariable("MIDNIGHT_MCP_PIPE") == null) Process.Start(new ProcessStartInfo(app) { UseShellExecute = false });
        }
        Thread.Sleep(500);
      }
    }
  }

  public static int Main(string[] args) {
    var utf8 = new UTF8Encoding(false);
    try {
      string token;
      try { token = File.ReadAllText(TokenFile()).Trim(); }
      catch (Exception) { throw new InvalidOperationException("midnight's connector is turned off. Turn on Settings > Connectors > Let other apps use midnight."); }
      using (var pipe = Connect(PipeName())) {
        var toPipe = new StreamWriter(pipe, utf8) { AutoFlush = true, NewLine = "\n" };
        toPipe.WriteLine("{\"token\":\"" + token + "\"}");
        var fromPipe = new StreamReader(pipe, utf8);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), utf8) { AutoFlush = true, NewLine = "\n" };
        var reader = new Thread(() => {
          try { string line; while ((line = fromPipe.ReadLine()) != null) stdout.WriteLine(line); }
          catch (Exception) { }
          Environment.Exit(0); // midnight closed the connection
        }) { IsBackground = true };
        reader.Start();
        var stdin = new StreamReader(Console.OpenStandardInput(), utf8);
        string input;
        while ((input = stdin.ReadLine()) != null) toPipe.WriteLine(input);
      }
      return 0;
    } catch (Exception e) {
      Console.Error.WriteLine("midnight-mcp: " + e.Message);
      return 1;
    }
  }
}
