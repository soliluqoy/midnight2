// Text recognition (OCR) for midnight with the engine built into Windows 10 and 11 (Windows.Media.Ocr): no
// download, no cloud. Built into midnight-ocr.exe by scripts/build-native.mjs.
//   midnight-ocr.exe <image path> [language tag]   ->  one JSON line: { language, text, lines: [{ text, x, y, w, h }] }
//   midnight-ocr.exe --languages                   ->  { languages: ["en-US", ...] }
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

public static class MidnightOcr {
  static string Json(string s) {
    var b = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c);
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  // Await a WinRT operation through its completion callback (no SDK-only projection assemblies needed).
  static Task<T> Await<T>(IAsyncOperation<T> op) {
    var done = new TaskCompletionSource<T>();
    op.Completed = (o, status) => {
      if (status == AsyncStatus.Completed) done.TrySetResult(o.GetResults());
      else if (status == AsyncStatus.Error) done.TrySetException(o.ErrorCode ?? new InvalidOperationException("The operation failed."));
      else done.TrySetCanceled();
    };
    return done.Task;
  }

  static async Task<string> Recognize(string path, string tag) {
    OcrEngine engine = null;
    if (!string.IsNullOrEmpty(tag)) {
      var lang = new Language(tag);
      if (OcrEngine.IsLanguageSupported(lang)) engine = OcrEngine.TryCreateFromLanguage(lang);
    }
    if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
    if (engine == null) throw new InvalidOperationException("No OCR language is installed. Add a language with Optical character recognition in Windows Settings > Time & language.");
    var file = await Await(StorageFile.GetFileFromPathAsync(Path.GetFullPath(path)));
    using (IRandomAccessStream stream = await Await(file.OpenAsync(FileAccessMode.Read))) {
      var decoder = await Await(BitmapDecoder.CreateAsync(stream));
      uint max = OcrEngine.MaxImageDimension;
      uint w = decoder.PixelWidth, h = decoder.PixelHeight;
      var transform = new BitmapTransform();
      if (w > max || h > max) {
        double k = Math.Min((double)max / w, (double)max / h);
        transform.ScaledWidth = (uint)(w * k);
        transform.ScaledHeight = (uint)(h * k);
      }
      var bitmap = await Await(decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform, ExifOrientationMode.RespectExifOrientation, ColorManagementMode.DoNotColorManage));
      var result = await Await(engine.RecognizeAsync(bitmap));
      var lines = new List<string>();
      var text = new StringBuilder();
      double scale = transform.ScaledWidth > 0 ? (double)w / transform.ScaledWidth : 1;
      foreach (var line in result.Lines) {
        double x0 = double.MaxValue, y0 = double.MaxValue, x1 = 0, y1 = 0;
        foreach (var word in line.Words) {
          var r = word.BoundingRect;
          x0 = Math.Min(x0, r.X); y0 = Math.Min(y0, r.Y); x1 = Math.Max(x1, r.X + r.Width); y1 = Math.Max(y1, r.Y + r.Height);
        }
        if (line.Words.Count == 0) { x0 = y0 = 0; }
        lines.Add(string.Format(System.Globalization.CultureInfo.InvariantCulture, "{{\"text\":{0},\"x\":{1:0},\"y\":{2:0},\"w\":{3:0},\"h\":{4:0}}}", Json(line.Text), x0 * scale, y0 * scale, (x1 - x0) * scale, (y1 - y0) * scale));
        text.Append(line.Text).Append('\n');
      }
      return "{\"language\":" + Json(engine.RecognizerLanguage.LanguageTag) + ",\"text\":" + Json(text.ToString().TrimEnd()) + ",\"lines\":[" + string.Join(",", lines) + "]}";
    }
  }

  public static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    try {
      if (args.Length > 0 && args[0] == "--languages") {
        var tags = new List<string>();
        foreach (var l in OcrEngine.AvailableRecognizerLanguages) tags.Add(Json(l.LanguageTag));
        Console.WriteLine("{\"languages\":[" + string.Join(",", tags) + "]}");
        return 0;
      }
      if (args.Length < 1) throw new ArgumentException("usage: midnight-ocr <image path> [language]");
      Console.WriteLine(Recognize(args[0], args.Length > 1 ? args[1] : null).GetAwaiter().GetResult());
      return 0;
    } catch (Exception e) {
      Console.WriteLine("{\"error\":" + Json(e.Message) + "}");
      return 1;
    }
  }
}
