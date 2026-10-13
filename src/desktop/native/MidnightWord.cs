// Typed Word selection broker. COM objects live on one STA with a message pump; opaque handles bind
// requests to their original live document/range, not a filename, repeated string, or later Selection.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Xml;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public static class MidnightWord {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 131072 };
  static readonly Dictionary<string, Target> targets = new Dictionary<string, Target>();
  static readonly Dictionary<string, Edit> edits = new Dictionary<string, Edit>();
  static DateTime lastRequest = DateTime.UtcNow;
  sealed class Target {
    public string Id, DocumentId, Kind, WindowId, Scope, BaseFormatKey, DrawingId, DrawingName;
    public uint ProcessId, ViewProcessId; // WPS can host the document view in a child process of the foreground frame
    public IntPtr ViewWindow;
    public dynamic Document, Range, Shape;
    public DateTime Expires;
    public bool Edited, ChartInline;
    public ParagraphFormatInfo Formatting;
  }
  sealed class FormatRun { public int Start, End; public string Key; public dynamic Range; }
  sealed class ParagraphFormatInfo {
    public List<FormatRun> Runs = new List<FormatRun>();
    public List<object> ProtectedSpans = new List<object>();
    public FormatRun Base;
    public string Preservation;
  }
  sealed class TextChange { public int Start, End; public string Text; }
  sealed class Edit { public string Fingerprint; public object Result; public DateTime Expires; }
  sealed class NativeFailure : Exception {
    public string Code; public bool Uncertain;
    public NativeFailure(string message, string code, bool uncertain = false) : base(message) { Code = code; Uncertain = uncertain; }
  }
  static string Hash(string text) {
    using (var hash = SHA256.Create()) return "sha256:" + BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(text))).Replace("-", "").ToLowerInvariant();
  }
  static long Timestamp() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds; }
  static uint ProcessOf(IntPtr window) { uint pid; GetWindowThreadProcessId(window, out pid); return pid; }
  static IntPtr RootWindow(IntPtr window) { IntPtr root = GetAncestor(window, 2); return root == IntPtr.Zero ? window : root; }
  static string Provider() {
    string clsid = Convert.ToString(Registry.GetValue(@"HKEY_CLASSES_ROOT\Word.Application\CLSID", "", ""));
    string server = Convert.ToString(Registry.GetValue(@"HKEY_CLASSES_ROOT\CLSID\" + clsid + @"\LocalServer32", "", ""));
    if (server.IndexOf("winword.exe", StringComparison.OrdinalIgnoreCase) >= 0) return "microsoft-word";
    if (server.IndexOf("wps.exe", StringComparison.OrdinalIgnoreCase) >= 0) return "wps";
    return "unknown";
  }
  static object Status() {
    string provider = Provider();
    return new { installed = Type.GetTypeFromProgID("Word.Application", false) != null, provider = provider, api = 1, readSelection = true, editText = true, convertChart = provider == "microsoft-word" || provider == "wps", chartQualification = provider == "wps" ? new { mode = "target-preflight", apiVersion = "12.0", build = "12.1.0.28485" } : null };
  }
  static bool Mixed(object value) { try { return Convert.ToDouble(value) == 9999999; } catch { return false; } }
  static Dictionary<string, object> ObjectMap(object value) { return json.Deserialize<Dictionary<string, object>>(json.Serialize(value)); }
  static void CheckChartProvider(Target target) {
    string provider = Provider();
    if (provider == "microsoft-word") return;
    if (provider != "wps" || Convert.ToString(target.Document.Application.Version) != "12.0" || Convert.ToString(target.Document.Application.Build) != "12.1.0.28485") throw new NativeFailure("Native chart edits are not qualified for this Office provider/build.", "TARGET_UNSUPPORTED");
    if (!target.ChartInline) {
      string id = Convert.ToString(target.Shape.ID), name = Convert.ToString(target.Shape.Name);
      if (!Regex.IsMatch(id, @"^[1-9][0-9]*$") || string.IsNullOrEmpty(name) || name.Length > 500) throw new NativeFailure("This floating chart has no exact drawing identity.", "TARGET_UNSUPPORTED");
      if (target.DrawingId != null && (target.DrawingId != id || target.DrawingName != name)) throw new NativeFailure("The original floating chart identity changed. Select it again.", "TARGET_CONFLICT");
      target.DrawingId = id; target.DrawingName = name;
    }
  }
  static List<string> WpsSeriesNameSources(Target target, int count) {
    CheckChartProvider(target);
    string xml = target.ChartInline ? Convert.ToString(target.Shape.Range.WordOpenXML) : Convert.ToString(target.Shape.Anchor.WordOpenXML);
    return SeriesNameSourcesFromXml(xml, count, target.DrawingId, target.DrawingName);
  }
  static List<string> SeriesNameSourcesFromXml(string xml, int count, string drawingId = null, string drawingName = null) {
    if (xml.Length > 8 * 1024 * 1024) throw new NativeFailure("This chart snapshot exceeds the quick-edit budget.", "TARGET_UNSUPPORTED");
    var document = new XmlDocument { XmlResolver = null };
    using (var reader = XmlReader.Create(new System.IO.StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024 })) document.Load(reader);
    var ns = new XmlNamespaceManager(document.NameTable);
    ns.AddNamespace("pkg", "http://schemas.microsoft.com/office/2006/xmlPackage"); ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
    ns.AddNamespace("c", "http://schemas.openxmlformats.org/drawingml/2006/chart"); ns.AddNamespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"); ns.AddNamespace("rel", "http://schemas.openxmlformats.org/package/2006/relationships");
    ns.AddNamespace("wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing");
    XmlNode main = null, relationships = null;
    foreach (XmlNode part in document.SelectNodes("/pkg:package/pkg:part", ns)) {
      string name = part.Attributes["name", ns.LookupNamespace("pkg")].Value;
      if (name == "/word/document.xml") { if (main != null) throw new NativeFailure("This chart package has ambiguous parts.", "TARGET_UNSUPPORTED"); main = part; }
      else if (name == "/word/_rels/document.xml.rels") { if (relationships != null) throw new NativeFailure("This chart package has ambiguous parts.", "TARGET_UNSUPPORTED"); relationships = part; }
    }
    if (main == null || relationships == null) throw new NativeFailure("This native chart has no exact local package binding.", "TARGET_UNSUPPORTED");
    XmlNode scope = main;
    if (drawingId != null) {
      scope = null;
      foreach (XmlNode anchor in main.SelectNodes("pkg:xmlData/w:document/w:body//wp:anchor", ns)) {
        XmlNode identity = anchor.SelectSingleNode("wp:docPr", ns);
        if (identity == null || identity.Attributes["id"].Value != drawingId) continue;
        if (scope != null || identity.Attributes["name"].Value != drawingName) throw new NativeFailure("The captured floating drawing has ambiguous identity.", "TARGET_UNSUPPORTED");
        scope = anchor;
      }
      if (scope == null) throw new NativeFailure("The exact captured floating drawing is missing.", "TARGET_UNSUPPORTED");
    }
    XmlNodeList refs = drawingId == null ? scope.SelectNodes("pkg:xmlData/w:document/w:body//c:chart", ns) : scope.SelectNodes(".//c:chart", ns);
    if (refs.Count != 1 || refs[0].Attributes["id", ns.LookupNamespace("r")] == null) throw new NativeFailure("Select exactly one native chart.", "TARGET_UNSUPPORTED");
    string id = refs[0].Attributes["id", ns.LookupNamespace("r")].Value, chartPath = null;
    foreach (XmlNode relation in relationships.SelectNodes("pkg:xmlData/rel:Relationships/rel:Relationship", ns)) {
      if (relation.Attributes["Id"].Value != id) continue;
      if (chartPath != null || relation.Attributes["Type"].Value != ns.LookupNamespace("r") + "/chart" || relation.Attributes["TargetMode"] != null || !Regex.IsMatch(relation.Attributes["Target"].Value, @"^charts/chart[1-9][0-9]*\.xml$")) throw new NativeFailure("This chart relationship is not a qualified local source.", "TARGET_UNSUPPORTED");
      chartPath = "/word/" + relation.Attributes["Target"].Value;
    }
    XmlNode chartPart = null;
    foreach (XmlNode part in document.SelectNodes("/pkg:package/pkg:part", ns)) if (part.Attributes["name", ns.LookupNamespace("pkg")].Value == chartPath) {
      if (chartPart != null) throw new NativeFailure("This chart package has ambiguous parts.", "TARGET_UNSUPPORTED"); chartPart = part;
    }
    if (chartPart == null) throw new NativeFailure("The selected native chart part is unavailable.", "TARGET_UNSUPPORTED");
    XmlNodeList series = chartPart.SelectNodes("pkg:xmlData/c:chartSpace/c:chart/c:plotArea/*/c:ser", ns);
    if (series.Count != count || chartPart.SelectNodes("pkg:xmlData/c:chartSpace//c:ser", ns).Count != series.Count) throw new NativeFailure("The native chart data and local package disagree.", "TARGET_UNSUPPORTED");
    var names = new List<string>();
    foreach (XmlNode entry in series) { XmlNode name = entry.SelectSingleNode("c:tx", ns); names.Add(Hash(name == null ? "" : name.OuterXml)); }
    return names; // Names, formulas/cache and XML stay local; only the preservation digest leaves the helper.
  }
  static object ChartData(Target target) {
    dynamic chart = target.Shape.Chart;
    dynamic series = chart.SeriesCollection();
    int count = Convert.ToInt32(series.Count);
    if (count > 10) throw new NativeFailure("This chart is too large for a quick edit.", "TARGET_UNSUPPORTED");
    List<string> nameSources = Provider() == "wps" ? WpsSeriesNameSources(target, count) : null;
    var data = new List<object>();
    for (int i = 1; i <= count; i++) {
      dynamic item = series.Item(i);
      object values = item.Values, categories = item.XValues;
      if ((values is Array && ((Array)values).Length > 500) || (categories is Array && ((Array)categories).Length > 500)) throw new NativeFailure("This chart is too large for a quick edit.", "TARGET_UNSUPPORTED");
      data.Add(new { name = nameSources == null ? Convert.ToString(item.Name) : nameSources[i - 1], values = values, categories = categories, formula = Convert.ToString(item.Formula) });
    }
    string title = Convert.ToBoolean(chart.HasTitle) ? Convert.ToString(chart.ChartTitle.Text) : "";
    int anchor; double left = 0, top = 0;
    if (target.ChartInline) anchor = Convert.ToInt32(target.Shape.Range.Start);
    else { anchor = Convert.ToInt32(target.Shape.Anchor.Start); left = Convert.ToDouble(target.Shape.Left); top = Convert.ToDouble(target.Shape.Top); }
    return new { data = data, title = title, width = Convert.ToDouble(target.Shape.Width), height = Convert.ToDouble(target.Shape.Height), anchor = anchor, left = left, top = top, drawingId = target.DrawingId, drawingName = target.DrawingName };
  }
  static string CharacterFormatKey(dynamic range) {
    dynamic font = range.Font;
    foreach (object value in new object [] { font.Size, font.Bold, font.Italic, font.Color, font.Underline, font.StrikeThrough, font.Hidden, font.Superscript, font.Subscript, font.Spacing, font.Scaling, range.HighlightColorIndex, range.LanguageID, range.NoProofing })
      if (Mixed(value)) throw new NativeFailure("This character formatting cannot be resolved safely.", "TARGET_UNSUPPORTED");
    if (string.IsNullOrEmpty(Convert.ToString(font.Name))) throw new NativeFailure("This character font cannot be resolved safely.", "TARGET_UNSUPPORTED");
    return json.Serialize(new { style = Convert.ToString(range.Style.NameLocal), name = Convert.ToString(font.Name), size = Convert.ToDouble(font.Size), bold = Convert.ToInt32(font.Bold), italic = Convert.ToInt32(font.Italic), color = Convert.ToInt32(font.Color), underline = Convert.ToInt32(font.Underline), strike = Convert.ToInt32(font.StrikeThrough), hidden = Convert.ToInt32(font.Hidden), superscript = Convert.ToInt32(font.Superscript), subscript = Convert.ToInt32(font.Subscript), spacing = Convert.ToDouble(font.Spacing), scaling = Convert.ToInt32(font.Scaling), highlight = Convert.ToInt32(range.HighlightColorIndex), language = Convert.ToInt32(range.LanguageID), noProofing = Convert.ToInt32(range.NoProofing) });
  }
  static ParagraphFormatInfo DescribeFormatting(Target target, string text, string xml) {
    if (xml.Length > 8 * 1024 * 1024) throw new NativeFailure("This formatting snapshot is too large.", "TARGET_UNSUPPORTED");
    var document = new XmlDocument { XmlResolver = null };
    using (var reader = XmlReader.Create(new System.IO.StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 8 * 1024 * 1024 })) document.Load(reader);
    var ns = new XmlNamespaceManager(document.NameTable); ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");
    var paragraphs = document.SelectNodes("//w:body/w:p", ns);
    if (paragraphs.Count != 1) throw new NativeFailure("Select text inside one ordinary paragraph.", "TARGET_UNSUPPORTED");
    var format = new ParagraphFormatInfo(); int offset = 0, origin = Convert.ToInt32(target.Range.Start), count = 0;
    foreach (XmlNode node in paragraphs[0].ChildNodes) {
      if (node.LocalName == "pPr" || node.LocalName == "proofErr") continue;
      if (node.NamespaceURI != ns.LookupNamespace("w") || node.LocalName != "r" || ++count > 128) throw new NativeFailure("This paragraph contains unqualified inline structure.", "TARGET_UNSUPPORTED");
      var content = new StringBuilder();
      foreach (XmlNode child in node.ChildNodes) {
        if (child.NamespaceURI != ns.LookupNamespace("w")) throw new NativeFailure("This paragraph contains unqualified inline structure.", "TARGET_UNSUPPORTED");
        if (child.LocalName == "rPr") continue;
        if (child.LocalName != "t") throw new NativeFailure("This paragraph contains unqualified inline structure.", "TARGET_UNSUPPORTED");
        content.Append(child.InnerText);
      }
      string runText = content.ToString(); if (runText.Length == 0) continue;
      if (offset + runText.Length > text.Length || !string.Equals(text.Substring(offset, runText.Length), runText, StringComparison.Ordinal)) throw new NativeFailure("The formatting snapshot does not match the captured text.", "TARGET_UNSUPPORTED");
      dynamic range = target.Range.Duplicate; range.SetRange(origin + offset, origin + offset + runText.Length);
      string key = CharacterFormatKey(range);
      if (format.Runs.Count > 0 && format.Runs[format.Runs.Count - 1].Key == key) format.Runs[format.Runs.Count - 1].End = offset + runText.Length;
      else format.Runs.Add(new FormatRun { Start = offset, End = offset + runText.Length, Key = key, Range = range });
      offset += runText.Length;
    }
    if (offset != text.Length || format.Runs.Count == 0 || format.Runs.Count > 32) throw new NativeFailure("This paragraph's formatting exceeds the quick-edit budget.", "TARGET_UNSUPPORTED");
    // Freeze the base style for this original handle, so rewriting a gap cannot change anchor classification.
    string baseKey = target.BaseFormatKey;
    if (baseKey == null) {
      var lengths = new Dictionary<string, int>();
      foreach (FormatRun run in format.Runs) { if (!lengths.ContainsKey(run.Key)) lengths[run.Key] = 0; lengths[run.Key] += run.End - run.Start; }
      int largest = -1; foreach (FormatRun run in format.Runs) if (lengths[run.Key] > largest) { largest = lengths[run.Key]; baseKey = run.Key; }
    }
    var preserved = new List<object>();
    foreach (FormatRun run in format.Runs) {
      if (run.Key == baseKey) { if (format.Base == null) format.Base = run; }
      else { format.ProtectedSpans.Add(new { start = run.Start, end = run.End }); preserved.Add(new { key = run.Key, anchor = text.Substring(run.Start, run.End - run.Start) }); }
    }
    if (format.Base == null) throw new NativeFailure("The original base formatting is unavailable.", "TARGET_UNSUPPORTED");
    target.BaseFormatKey = baseKey;
    XmlNode paragraphProperties = paragraphs[0].SelectSingleNode("w:pPr", ns);
    format.Preservation = Hash(json.Serialize(new { baseKey = baseKey, anchors = preserved, paragraph = paragraphProperties == null ? "" : paragraphProperties.OuterXml }));
    return format;
  }
  static object Inspect(Target target) {
    if (target.Expires <= DateTime.UtcNow) throw new InvalidOperationException("The original target expired. Select it again.");
    if (Convert.ToInt32(target.Document.Windows.Count) < 1) throw new InvalidOperationException("The original document is closed.");
    bool originalWindow = false;
    for (int i = 1; i <= Convert.ToInt32(target.Document.Windows.Count); i++) {
      IntPtr view = new IntPtr(Convert.ToInt64(target.Document.Windows.Item(i).Hwnd));
      if (view == target.ViewWindow && ProcessOf(view) == (target.ViewProcessId != 0 ? target.ViewProcessId : target.ProcessId) && RootWindow(view).ToInt64().ToString() == target.WindowId) originalWindow = true;
    }
    if (!originalWindow) throw new NativeFailure("The original document window is unavailable. Select the target again.", "TARGET_CONFLICT");
    string text = "";
    object metadata;
    string structureHash, preservationHash;
    if (target.Kind == "paragraph") {
      text = Convert.ToString(target.Range.Text) ?? "";
      if (text.Length > 6000 || text.IndexOf('\a') >= 0 || text.IndexOf('\r') >= 0) throw new InvalidOperationException("Select a smaller text range inside one paragraph.");
      bool unsupported = Convert.ToInt32(target.Range.Fields.Count) > 0 || Convert.ToInt32(target.Range.Hyperlinks.Count) > 0 || Convert.ToInt32(target.Range.Revisions.Count) > 0 || Convert.ToInt32(target.Range.Tables.Count) > 0 || Convert.ToInt32(target.Range.InlineShapes.Count) > 0 || Convert.ToInt32(target.Range.ContentControls.Count) > 0;
      dynamic font = target.Range.Font;
      bool mixed = Mixed(font.Size) || Mixed(font.Bold) || Mixed(font.Italic) || Mixed(font.Color) || Mixed(font.Underline) || Mixed(font.StrikeThrough) || Mixed(font.Hidden) || Mixed(font.Superscript) || Mixed(font.Subscript) || Mixed(font.Spacing) || Mixed(font.Scaling);
      string name = Convert.ToString(font.Name) ?? "";
      bool supported = !unsupported && !string.IsNullOrWhiteSpace(text) && !Convert.ToBoolean(target.Document.TrackRevisions) && Convert.ToInt32(target.Document.ProtectionType) == -1 && !Convert.ToBoolean(target.Document.ReadOnly) && text.Length == Convert.ToInt32(target.Range.End) - Convert.ToInt32(target.Range.Start);
      // WordOpenXML is confined to this range and stays local; the model receives neither XML nor the document.
      string xml = Convert.ToString(target.Range.WordOpenXML); structureHash = Hash(xml);
      target.Formatting = null;
      try { target.Formatting = DescribeFormatting(target, text, xml); }
      catch (NativeFailure) { supported = false; }
      catch (XmlException) { supported = false; }
      preservationHash = target.Formatting == null ? Hash("unsupported-formatting") : target.Formatting.Preservation;
      metadata = new { scope = target.Scope ?? "selection", style = Convert.ToString(target.Range.Style.NameLocal), font = name, size = mixed ? 0 : Convert.ToDouble(font.Size), bold = !mixed && Convert.ToInt32(font.Bold) != 0, italic = !mixed && Convert.ToInt32(font.Italic) != 0, supported = supported, protectedSpans = target.Formatting == null ? new List<object>() : target.Formatting.ProtectedSpans };
    } else {
      dynamic chart = target.Shape.Chart;
      dynamic series = chart.SeriesCollection();
      int count = Convert.ToInt32(series.Count);
      object values = count > 0 ? series.Item(1).Values : null;
      int categories = values is Array ? ((Array)values).Length : values == null ? 0 : 1;
      string title = Convert.ToBoolean(chart.HasTitle) ? Convert.ToString(chart.ChartTitle.Text) : "";
      metadata = new { chartType = Convert.ToInt32(chart.ChartType), seriesCount = count, categoryCount = categories, title = title, editable = !Convert.ToBoolean(target.Document.ReadOnly) && Convert.ToInt32(target.Document.ProtectionType) == -1 };
      structureHash = Hash(json.Serialize(new { type = Convert.ToInt32(chart.ChartType), properties = ChartData(target) }));
      preservationHash = Hash(json.Serialize(ChartData(target)));
    }
    return new { handle = target.Id, documentId = target.DocumentId, kind = target.Kind, processId = target.ProcessId, windowId = target.WindowId, text = text, metadata = metadata, structureHash = structureHash, preservationHash = preservationHash, capturedAt = Timestamp() };
  }
  static object Capture(Dictionary<string, object> request) {
    int pending = 0; foreach (Target item in targets.Values) if (!item.Edited) pending++;
    if (pending >= 8 || targets.Count >= 64) throw new InvalidOperationException("Finish a pending edit before selecting another target.");
    IntPtr hwnd = GetForegroundWindow();
    uint pid = ProcessOf(hwnd);
    if (request.ContainsKey("expectedWindowId") && (Convert.ToString(request["expectedWindowId"]) != RootWindow(hwnd).ToInt64().ToString() || !request.ContainsKey("expectedProcessId") || Convert.ToUInt32(request["expectedProcessId"]) != pid)) throw new NativeFailure("The foreground changed after the voice gesture. No target was read.", "TARGET_CONFLICT");
    using (var process = Process.GetProcessById((int)pid)) if (!string.Equals(process.ProcessName, "WINWORD", StringComparison.OrdinalIgnoreCase) && !string.Equals(process.ProcessName, "wps", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Select a paragraph or native chart in Word or WPS first.");
    // Attach only. Never create Word, open a file, activate a window, or change a selection.
    dynamic word = Marshal.GetActiveObject("Word.Application");
    IntPtr viewWindow = new IntPtr(Convert.ToInt64(word.ActiveWindow.Hwnd));
    uint viewPid = ProcessOf(viewWindow);
    if (RootWindow(viewWindow) != RootWindow(hwnd)) throw new InvalidOperationException("The captured Word window belongs to another instance. No target was read.");
    if (viewPid != pid) using (var viewProcess = Process.GetProcessById((int)viewPid)) if (!string.Equals(viewProcess.ProcessName, "WINWORD", StringComparison.OrdinalIgnoreCase) && !string.Equals(viewProcess.ProcessName, "wps", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The captured Word window belongs to another instance. No target was read.");
    dynamic selection = word.Selection;
    var target = new Target { Id = Guid.NewGuid().ToString(), DocumentId = Guid.NewGuid().ToString(), Document = word.ActiveDocument, ProcessId = pid, ViewProcessId = viewPid, ViewWindow = viewWindow, WindowId = RootWindow(hwnd).ToInt64().ToString(), Expires = DateTime.UtcNow.AddSeconds(60) };
    dynamic shape = null;
    if (Convert.ToInt32(selection.InlineShapes.Count) == 1) { shape = selection.InlineShapes.Item(1); target.ChartInline = true; }
    else { try { if (Convert.ToInt32(selection.ShapeRange.Count) == 1) shape = selection.ShapeRange.Item(1); } catch (COMException) {} catch (Microsoft.CSharp.RuntimeBinder.RuntimeBinderException) {} }
    if (shape != null) {
      if (Convert.ToInt32(shape.HasChart) != -1) throw new InvalidOperationException("This is a picture or another object, not an editable native chart.");
      target.Kind = "chart"; target.Shape = shape;
      CheckChartProvider(target);
    } else {
      target.Kind = "paragraph";
      dynamic range = selection.Range.Duplicate;
      target.Scope = "selection";
      if (Convert.ToInt32(range.Start) == Convert.ToInt32(range.End)) { range = selection.Paragraphs.Item(1).Range.Duplicate; target.Scope = "paragraph"; }
      string content = Convert.ToString(range.Text) ?? "";
      if (content.EndsWith("\r")) range.End = Convert.ToInt32(range.End) - 1;
      target.Range = range;
    }
    object result = Inspect(target);
    targets.Add(target.Id, target);
    return result;
  }
  static void CheckExpected(Dictionary<string, object> current, Dictionary<string, object> expected) {
    foreach (string key in new [] { "handle", "documentId", "kind", "windowId", "processId", "structureHash" })
      if (!expected.ContainsKey(key) || Convert.ToString(expected[key]) != Convert.ToString(current[key])) throw new NativeFailure("The original target changed. Select it again.", "TARGET_CONFLICT");
    if (!expected.ContainsKey("textHash") || Convert.ToString(expected["textHash"]) != Hash(Convert.ToString(current["text"]))) throw new NativeFailure("The selected text changed. Select it again.", "TARGET_CONFLICT");
  }
  static bool SafeText(string text) {
    if (string.IsNullOrWhiteSpace(text) || text.Length > 6000 || Encoding.UTF8.GetByteCount(text) > 12000) return false;
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (char.IsControl(c) || c == '\u2028' || c == '\u2029') return false;
      if (char.IsHighSurrogate(c)) { if (i + 1 >= text.Length || !char.IsLowSurrogate(text[++i])) return false; }
      else if (char.IsLowSurrogate(c)) return false;
    }
    return true;
  }
  static void AddChange(List<TextChange> changes, string before, string text, int source) {
    int start = 0;
    while (start < before.Length && start < text.Length && before[start] == text[start]) start++;
    if (start > 0 && ((start < before.Length && char.IsLowSurrogate(before[start])) || (start < text.Length && char.IsLowSurrogate(text[start])))) start--;
    int end = before.Length, nextEnd = text.Length;
    while (end > start && nextEnd > start && before[end - 1] == text[nextEnd - 1]) { end--; nextEnd--; }
    if ((end < before.Length && char.IsLowSurrogate(before[end])) || (nextEnd < text.Length && char.IsLowSurrogate(text[nextEnd]))) { end++; nextEnd++; }
    if (start != end || start != nextEnd) changes.Add(new TextChange { Start = source + start, End = source + end, Text = text.Substring(start, nextEnd - start) });
  }
  static List<TextChange> PlanText(Target target, string text) {
    string before = Convert.ToString(target.Range.Text); var changes = new List<TextChange>(); int source = 0, destination = 0; bool first = true, baseRemaining = false;
    if (target.Formatting == null) throw new NativeFailure("The selected text's formatting is unavailable. Select it again.", "TARGET_UNSUPPORTED");
    foreach (FormatRun run in target.Formatting.Runs) {
      if (run.Key == target.BaseFormatKey) continue;
      string anchor = before.Substring(run.Start, run.End - run.Start); int found = text.IndexOf(anchor, StringComparison.Ordinal);
      if (before.IndexOf(anchor, StringComparison.Ordinal) != run.Start || before.LastIndexOf(anchor, StringComparison.Ordinal) != run.Start || found < destination || text.LastIndexOf(anchor, StringComparison.Ordinal) != found) throw new NativeFailure("Keep each styled phrase unchanged, once, and in its original order.", "TARGET_UNSUPPORTED");
      if (!first && (run.Start == source) != (found == destination)) throw new NativeFailure("Keep the text between styled phrases so their formatting boundaries remain intact.", "TARGET_UNSUPPORTED");
      first = false; baseRemaining |= found > destination;
      AddChange(changes, before.Substring(source, run.Start - source), text.Substring(destination, found - destination), source);
      source = run.End; destination = found + anchor.Length;
    }
    if (target.Formatting.ProtectedSpans.Count > 0 && !baseRemaining && destination == text.Length) throw new NativeFailure("Keep the text between styled phrases so their formatting boundaries remain intact.", "TARGET_UNSUPPORTED");
    AddChange(changes, before.Substring(source), text.Substring(destination), source); return changes;
  }
  static void ReplaceText(Target target, string text, List<TextChange> changes) {
    int origin = Convert.ToInt32(target.Range.Start); dynamic source = target.Formatting.Base.Range, font = source.Font.Duplicate;
    int highlight = Convert.ToInt32(source.HighlightColorIndex), language = Convert.ToInt32(source.LanguageID), noProofing = Convert.ToInt32(source.NoProofing);
    // Commit from the end so every offset still refers to the original range. Styled anchors are never replaced.
    for (int i = changes.Count - 1; i >= 0; i--) {
      TextChange change = changes[i]; dynamic part = target.Range.Duplicate;
      part.SetRange(origin + change.Start, origin + change.End); part.Text = change.Text;
      if (change.Text.Length > 0) { part.Font = font; part.HighlightColorIndex = highlight; part.LanguageID = language; part.NoProofing = noProofing; }
    }
    target.Range.SetRange(origin, origin + text.Length);
  }
  static void CheckPie(Target target) {
    dynamic chart = target.Shape.Chart;
    int type = Convert.ToInt32(chart.ChartType);
    if (type != 51 && type != 57) throw new NativeFailure("Select a supported 2D column or bar chart.", "TARGET_UNSUPPORTED");
    dynamic series = chart.SeriesCollection();
    if (Convert.ToInt32(series.Count) != 1) throw new NativeFailure("Choose one series before converting this chart to pie.", "TARGET_UNSUPPORTED");
    object values = series.Item(1).Values;
    var entries = new List<object>();
    if (values is Array) foreach (object value in (Array)values) entries.Add(value); else entries.Add(values);
    double total = 0;
    foreach (object value in entries) {
      double number;
      if (value == null || !double.TryParse(Convert.ToString(value), out number) || double.IsNaN(number) || double.IsInfinity(number) || number < 0) throw new NativeFailure("A pie chart needs nonnegative numeric values representing parts of a whole.", "TARGET_UNSUPPORTED");
      total += number;
    }
    if (total <= 0 || double.IsInfinity(total)) throw new NativeFailure("A pie chart needs a positive total.", "TARGET_UNSUPPORTED");
  }
  static object Apply(Target target, Dictionary<string, object> request) {
    string editId = Convert.ToString(request["editId"]), operation = Convert.ToString(request["operation"]);
    if (editId.Length < 8 || editId.Length > 100) throw new NativeFailure("Invalid edit identity.", "TARGET_INVALID");
    string fingerprint = Hash(json.Serialize(new { handle = target.Id, operation = operation, expected = request["expected"], text = request.ContainsKey("text") ? request["text"] : null, chartType = request.ContainsKey("chartType") ? request["chartType"] : null }));
    Edit duplicate;
    if (edits.TryGetValue(editId, out duplicate)) {
      if (duplicate.Fingerprint != fingerprint) throw new NativeFailure("This edit identity belongs to another change.", "EDIT_ID_CONFLICT");
      return duplicate.Result;
    }
    if (edits.Count >= 64) throw new NativeFailure("The quick-edit receipt buffer is full.", "TARGET_QUEUE_FULL");
    var before = ObjectMap(Inspect(target));
    CheckExpected(before, (Dictionary<string, object>)request["expected"]);
    var metadata = ObjectMap(before["metadata"]);
    string text = request.ContainsKey("text") ? Convert.ToString(request["text"]) : "";
    int chartType = request.ContainsKey("chartType") ? Convert.ToInt32(request["chartType"]) : 0;
    string preservation; List<TextChange> changes = null;
    if (operation == "paragraph.replace") {
      if (target.Kind != "paragraph" || !Convert.ToBoolean(metadata["supported"]) || !SafeText(text)) throw new NativeFailure("This text structure is not qualified for direct replacement.", "TARGET_UNSUPPORTED");
      preservation = Convert.ToString(before["preservationHash"]);
      changes = PlanText(target, text); // all format/anchor refusals occur before the first native mutation
    } else if (operation == "chart.setType" || operation == "chart.restoreType") {
      CheckChartProvider(target);
      if (target.Kind != "chart" || !Convert.ToBoolean(metadata["editable"]) || Convert.ToBoolean(target.Document.TrackRevisions)) throw new NativeFailure("This chart is protected or tracked.", "TARGET_UNSUPPORTED");
      if (operation == "chart.setType") { if (chartType != 5) throw new NativeFailure("Only a pie conversion is supported.", "TARGET_UNSUPPORTED"); CheckPie(target); }
      else if ((chartType != 51 && chartType != 57) || Convert.ToInt32(target.Shape.Chart.ChartType) != 5) throw new NativeFailure("This chart reversal is not supported.", "TARGET_UNSUPPORTED");
      preservation = Hash(json.Serialize(ChartData(target)));
    } else throw new NativeFailure("Unsupported typed edit.", "TARGET_INVALID");
    dynamic undo = target.Document.Application.UndoRecord;
    if (Convert.ToInt32(undo.CustomRecordLevel) != 0) throw new NativeFailure("Word is already recording another edit. Try again when it finishes.", "WORD_BUSY");
    // Formatting reads use several COM calls. Recheck exact range content/structure after that preflight.
    if (operation == "paragraph.replace" && (Convert.ToString(target.Range.Text) != Convert.ToString(before["text"]) || Hash(Convert.ToString(target.Range.WordOpenXML)) != Convert.ToString(before["structureHash"]))) throw new NativeFailure("The original target changed during preparation. Select it again.", "TARGET_CONFLICT");
    if (target.Kind == "chart" && (Convert.ToInt32(target.Shape.Chart.ChartType) != Convert.ToInt32(metadata["chartType"]) || Hash(json.Serialize(ChartData(target))) != preservation)) throw new NativeFailure("The native chart changed during preparation. Select it again.", "TARGET_CONFLICT");
    bool attempted = false, recording = false;
    try {
      undo.StartCustomRecord("Midnight quick edit"); recording = true;
      // No inference, async work or retry is inside this short synchronous native commit.
      attempted = true;
	  target.Edited = true; target.Expires = DateTime.UtcNow.AddMinutes(10);
      if (operation == "paragraph.replace") ReplaceText(target, text, changes); else target.Shape.Chart.ChartType = chartType;
      undo.EndCustomRecord(); recording = false;
      var after = ObjectMap(Inspect(target));
      bool preserved = preservation == Convert.ToString(after["preservationHash"]);
      bool changed = target.Kind == "paragraph" ? Convert.ToString(after["text"]) == text : Convert.ToInt32(target.Shape.Chart.ChartType) == chartType;
      if (!preserved || !changed) throw new NativeFailure("Word changed the target, but verification needs reconciliation.", "EDIT_UNKNOWN", true);
      target.Edited = true; target.Expires = DateTime.UtcNow.AddMinutes(10);
      object result = new { editId = editId, state = "verified", snapshot = after, verification = new [] { "original-native-target", "expected-content", "preserved-common-properties" } };
      edits.Add(editId, new Edit { Fingerprint = fingerprint, Result = result, Expires = target.Expires });
      return result;
    } catch (NativeFailure failure) {
        if (attempted && !failure.Uncertain) throw new NativeFailure("The edit may have happened. Verification needs reconciliation.", "EDIT_UNKNOWN", true);
        throw;
      }
      catch { throw new NativeFailure(attempted ? "Word may have applied the edit. Inspect its outcome before retrying." : "Word is busy. No edit was dispatched.", attempted ? "EDIT_UNKNOWN" : "WORD_BUSY", attempted); }
      finally { if (recording) { try { undo.EndCustomRecord(); } catch {} } }
  }
  static object Execute(Dictionary<string, object> request) {
    string op = Convert.ToString(request["op"]);
#if MIDNIGHT_WORD_FIXTURES
    if (workflowTarget != null && op == "status") return WorkflowStatus();
    if (workflowTarget != null && op == "capture") {
      if (request.ContainsKey("expectedWindowId") && (Convert.ToString(request["expectedWindowId"]) != workflowTarget.WindowId || !request.ContainsKey("expectedProcessId") || Convert.ToUInt32(request["expectedProcessId"]) != workflowTarget.ProcessId)) throw new NativeFailure("The fixture target identity changed.", "TARGET_CONFLICT");
      targets[workflowTarget.Id] = workflowTarget;
      return Inspect(workflowTarget); // Real owned native range; foreground capture is deliberately a fixture boundary.
    }
#endif
    if (op == "status") return Status();
    if (op == "capture") return Capture(request);
    if (op == "receipt") {
      Edit edit; bool found = edits.TryGetValue(Convert.ToString(request["editId"]), out edit);
      return new { found = found, result = found ? edit.Result : null };
    }
    string handle = request.ContainsKey("handle") ? Convert.ToString(request["handle"]) : "";
    if (op == "release") return new { released = targets.Remove(handle) };
    Target target;
    if (!targets.TryGetValue(handle, out target)) throw new InvalidOperationException("The original target is unavailable. Select it again.");
    if (op == "inspect") return Inspect(target);
    if (op == "apply") return Apply(target, request);
    throw new InvalidOperationException("Unsupported Word operation.");
  }
  static void Respond(string line) {
    object id = null;
    try {
      if (line.Length > 65536) throw new InvalidOperationException("Word request is too large.");
      var request = json.Deserialize<Dictionary<string, object>>(line);
      id = request["id"];
      lastRequest = DateTime.UtcNow;
      Console.WriteLine(json.Serialize(new { id = id, ok = true, result = Execute(request) }));
    } catch (Exception error) {
      var failure = error as NativeFailure;
      Console.WriteLine(json.Serialize(new { id = id, ok = false, error = error.Message, code = failure == null ? "WORD_UNAVAILABLE" : failure.Code, uncertain = failure != null && failure.Uncertain }));
    }
  }
#if MIDNIGHT_WORD_FIXTURES
  static Target workflowTarget;
  static dynamic workflowWord, workflowDocument;
  static bool workflowOwned;
  static string workflowOriginal, workflowCreatedAt;
  static object WorkflowStatus() {
    return new { installed = true, provider = Provider(), api = 1, fixture = new {
      processId = workflowTarget.ProcessId, createdAtTicks = workflowCreatedAt, wordVersion = Convert.ToString(workflowWord.Version), wordBuild = Convert.ToString(workflowWord.Build),
      original = workflowOriginal, documentText = Convert.ToString(workflowDocument.Content.Text), snapshot = Inspect(workflowTarget),
      hidden = !Convert.ToBoolean(workflowWord.Visible), foregroundWindow = GetForegroundWindow().ToInt64().ToString()
    } };
  }
  static int Workflow() {
    var existing = new HashSet<int>(); foreach (var process in Process.GetProcesses()) { existing.Add(process.Id); process.Dispose(); }
    try {
      workflowWord = Activator.CreateInstance(Type.GetTypeFromProgID("Word.Application", true));
      Require(Convert.ToInt32(workflowWord.Documents.Count) == 0, "workflow instance has no existing documents");
      workflowDocument = workflowWord.Documents.Add();
      IntPtr view = new IntPtr(Convert.ToInt64(workflowDocument.Windows.Item(1).Hwnd)); uint pid = ProcessOf(view);
      Require(!existing.Contains((int)pid), "workflow process is separate from all pre-existing Office processes");
      workflowOwned = true; workflowWord.Visible = false; workflowWord.DisplayAlerts = 0;
      using (var process = Process.GetProcessById((int)pid)) workflowCreatedAt = process.StartTime.ToUniversalTime().Ticks.ToString();
      string paragraph = "As regards the quarter, North had revenue that rose by 12% even though there were higher costs.";
      workflowDocument.Content.Text = "PRIVATE_UNRELATED_LEAD.\r" + paragraph + "\r" + paragraph + "\rPRIVATE_UNRELATED_TAIL.\r";
      workflowDocument.Content.Font.Name = "Calibri"; workflowDocument.Content.Font.Size = 11;
      dynamic range = workflowDocument.Paragraphs.Item(2).Range.Duplicate; range.End = Convert.ToInt32(range.End) - 1;
      int origin = Convert.ToInt32(range.Start);
      workflowDocument.Range(origin + paragraph.IndexOf("North"), origin + paragraph.IndexOf("North") + 5).Font.Bold = -1;
      workflowDocument.Range(origin + paragraph.IndexOf("12%"), origin + paragraph.IndexOf("12%") + 3).Font.Italic = -1;
      dynamic costs = workflowDocument.Range(origin + paragraph.IndexOf("higher costs"), origin + paragraph.IndexOf("higher costs") + 12);
      costs.Font.Color = 255; costs.HighlightColorIndex = 7;
      range.ParagraphFormat.LeftIndent = 18; range.ParagraphFormat.SpaceAfter = 6;
      workflowOriginal = Convert.ToString(workflowDocument.Content.Text);
      workflowTarget = new Target { Id = Guid.NewGuid().ToString(), DocumentId = Guid.NewGuid().ToString(), Kind = "paragraph", Scope = "paragraph", Document = workflowDocument, Range = range, ProcessId = pid, ViewWindow = view, WindowId = RootWindow(view).ToInt64().ToString(), Expires = DateTime.UtcNow.AddMinutes(1) };
      targets.Add(workflowTarget.Id, workflowTarget);
      Require(Convert.ToBoolean(ObjectMap(ObjectMap(Inspect(workflowTarget))["metadata"])["supported"]), "mixed-format workflow range supports a direct rewrite");
      return RunProtocol();
    } finally {
      object rawDocument = workflowDocument, rawWord = workflowWord;
      targets.Clear(); edits.Clear(); workflowTarget = null;
      if (workflowDocument != null) { try { workflowDocument.Close(0); } catch {} }
      if (workflowOwned && workflowWord != null) { try { workflowWord.Quit(0); } catch {} }
      try { if (rawDocument != null && Marshal.IsComObject(rawDocument)) Marshal.FinalReleaseComObject(rawDocument); } catch {}
      try { if (rawWord != null && Marshal.IsComObject(rawWord)) Marshal.FinalReleaseComObject(rawWord); } catch {}
      workflowWord = workflowDocument = null;
    }
  }
  static void ChartParserFixtures() {
    string xml = "<pkg:package xmlns:pkg='http://schemas.microsoft.com/office/2006/xmlPackage' xmlns:w='http://schemas.openxmlformats.org/wordprocessingml/2006/main' xmlns:c='http://schemas.openxmlformats.org/drawingml/2006/chart' xmlns:r='http://schemas.openxmlformats.org/officeDocument/2006/relationships'><pkg:part pkg:name='/word/document.xml'><pkg:xmlData><w:document><w:body><w:p><c:chart r:id='owned-chart'/></w:p></w:body></w:document></pkg:xmlData></pkg:part><pkg:part pkg:name='/word/_rels/document.xml.rels'><pkg:xmlData><Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'><Relationship Id='owned-chart' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart' Target='charts/chart1.xml'/></Relationships></pkg:xmlData></pkg:part><pkg:part pkg:name='/word/charts/chart1.xml'><pkg:xmlData><c:chartSpace><c:chart><c:plotArea><c:barChart><c:ser><c:tx><c:v>Owned source</c:v></c:tx></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace></pkg:xmlData></pkg:part></pkg:package>";
    Require(SeriesNameSourcesFromXml(xml, 1).Count == 1, "name source resolves through the captured chart's exact local relationship");
    foreach (string invalid in new [] {
      xml.Replace("Target='charts/chart1.xml'", "Target='https://example.test/chart.xml' TargetMode='External'"),
      xml.Replace("charts/chart1.xml", "../charts/chart1.xml"),
      xml.Replace("r:id='owned-chart'", "r:id='another-chart'"),
      xml.Replace("<c:chart r:id='owned-chart'/>", "<c:chart r:id='owned-chart'/><c:chart r:id='owned-chart'/>"),
      xml.Replace("</pkg:package>", "<pkg:part pkg:name='/word/charts/chart1.xml'><pkg:xmlData/></pkg:part></pkg:package>"),
      xml.Replace("</pkg:package>", "<pkg:part pkg:name='/word/document.xml'><pkg:xmlData/></pkg:part></pkg:package>"),
      xml.Replace("<c:ser>", "<c:ser><c:ser/>")
    }) {
      try { SeriesNameSourcesFromXml(invalid, 1); throw new Exception("Unqualified chart package accepted."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED", "ambiguous/external/traversed/missing chart binding refused"); }
    }
    try { SeriesNameSourcesFromXml("<!DOCTYPE package [<!ENTITY read SYSTEM 'file:///never-read'>]>" + xml, 1); throw new Exception("DTD accepted."); }
    catch (XmlException) {}
    string floating = xml.Replace("<c:chart r:id='owned-chart'/>", "<wp:anchor xmlns:wp='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'><wp:docPr id='7' name='Owned drawing'/><c:chart r:id='owned-chart'/></wp:anchor><c:chart r:id='unrelated-chart'/>");
    Require(SeriesNameSourcesFromXml(floating, 1, "7", "Owned drawing")[0] == SeriesNameSourcesFromXml(xml, 1)[0], "floating source resolves only the captured drawing while other chart refs remain outside its scope");
    foreach (string invalid in new [] { floating.Replace("id='7'", "id='8'"), floating.Replace("name='Owned drawing'", "name='Another drawing'"), floating.Replace("</w:p>", "<wp:anchor xmlns:wp='http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'><wp:docPr id='7' name='Owned drawing'/><c:chart r:id='owned-chart'/></wp:anchor></w:p>") }) {
      try { SeriesNameSourcesFromXml(invalid, 1, "7", "Owned drawing"); throw new Exception("Wrong floating drawing accepted."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED", "wrong/duplicate floating drawing refused"); }
    }
  }
  static object ProbeRead(string name, Func<object> read) {
    try { return new { name = name, ok = true, value = read() }; }
    catch (Exception error) { return new { name = name, ok = false, hresult = "0x" + error.HResult.ToString("X8"), error = error.GetType().Name }; }
  }
  static object ProbeXml(dynamic range) {
    string xml = Convert.ToString(range.WordOpenXML);
    var parsed = new XmlDocument { XmlResolver = null }; parsed.LoadXml(xml);
    var ns = new XmlNamespaceManager(parsed.NameTable); ns.AddNamespace("c", "http://schemas.openxmlformats.org/drawingml/2006/chart"); ns.AddNamespace("pkg", "http://schemas.microsoft.com/office/2006/xmlPackage"); ns.AddNamespace("wp", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing");
    var names = new List<string>(); foreach (XmlNode node in parsed.SelectNodes("//pkg:part", ns)) names.Add(node.Attributes["name", ns.LookupNamespace("pkg")].Value);
    var types = new List<string>(); foreach (XmlNode node in parsed.SelectNodes("//c:plotArea/*", ns)) types.Add(node.LocalName);
    var ids = new List<object>(); foreach (XmlNode node in parsed.SelectNodes("//wp:docPr", ns)) ids.Add(new { id = node.Attributes["id"].Value, name = node.Attributes["name"].Value });
    return new { chars = xml.Length, chartSpaces = parsed.SelectNodes("//c:chartSpace", ns).Count, series = parsed.SelectNodes("//c:ser", ns).Count, parts = names, plotTypes = types, drawingIds = ids };
  }
  static int ChartProbe() {
    var existing = new HashSet<int>(); foreach (var process in Process.GetProcesses()) { existing.Add(process.Id); process.Dispose(); }
    dynamic word = null, document = null; bool owned = false; uint pid = 0;
    try {
      word = Activator.CreateInstance(Type.GetTypeFromProgID("Word.Application", true));
      Require(Convert.ToInt32(word.Documents.Count) == 0, "new automation instance has no existing documents");
      document = word.Documents.Add(); IntPtr hwnd = new IntPtr(Convert.ToInt64(document.Windows.Item(1).Hwnd)); pid = ProcessOf(hwnd);
      Require(!existing.Contains((int)pid), "chart probe owns a separate new Office process"); owned = true; word.Visible = false; word.DisplayAlerts = 0;
      Console.WriteLine(json.Serialize(new { kind = "fixture-owned", processId = pid }));
      document.Content.Text = "Disposable chart probe.\r";
      dynamic insertion = document.Range(Convert.ToInt32(document.Content.End) - 1, Convert.ToInt32(document.Content.End) - 1);
      dynamic shape = document.InlineShapes.AddChart2(-1, 57, insertion, false);
      var probes = new List<object>();
      probes.Add(ProbeRead("shape.HasChart", () => Convert.ToInt32(shape.HasChart)));
      probes.Add(ProbeRead("shape.Range.WordOpenXML", () => ProbeXml(shape.Range)));
      probes.Add(ProbeRead("shape.WidthHeight", () => new { width = Convert.ToDouble(shape.Width), height = Convert.ToDouble(shape.Height) }));
      dynamic chart = null;
      probes.Add(ProbeRead("shape.Chart", () => { chart = shape.Chart; return chart != null; }));
      if (chart != null) {
        probes.Add(ProbeRead("chart.ChartType", () => Convert.ToInt32(chart.ChartType)));
        probes.Add(ProbeRead("chart.SeriesCollection.Count", () => Convert.ToInt32(chart.SeriesCollection().Count)));
        probes.Add(ProbeRead("series.Values", () => chart.SeriesCollection().Item(1).Values));
        probes.Add(ProbeRead("series.XValues", () => chart.SeriesCollection().Item(1).XValues));
        probes.Add(ProbeRead("series.Formula", () => Convert.ToString(chart.SeriesCollection().Item(1).Formula)));
        probes.Add(ProbeRead("series.Name", () => Convert.ToString(chart.SeriesCollection().Item(1).Name)));
        probes.Add(ProbeRead("chart.HasTitle", () => Convert.ToBoolean(chart.HasTitle)));
        probes.Add(ProbeRead("chart.ChartTitle.Text", () => Convert.ToString(chart.ChartTitle.Text)));
        probes.Add(ProbeRead("chart.ChartData", () => chart.ChartData != null));
        probes.Add(ProbeRead("chart.ChartData.Workbook", () => chart.ChartData.Workbook != null));
        IntPtr foreground = GetForegroundWindow();
        probes.Add(ProbeRead("chart.ChartType.pie-and-restore", () => {
          int before = Convert.ToInt32(chart.ChartType); chart.ChartType = 5; int after = Convert.ToInt32(chart.ChartType);
          var xml = ProbeXml(shape.Range); chart.ChartType = before;
          return new { before = before, after = after, restored = Convert.ToInt32(chart.ChartType), focusPreserved = GetForegroundWindow() == foreground, xmlAfter = xml };
        }));
        probes.Add(ProbeRead("series.Values.set", () => { chart.SeriesCollection().Item(1).Values = new double [] { 2, 3, 5 }; return chart.SeriesCollection().Item(1).Values; }));
        probes.Add(ProbeRead("series.Delete", () => { chart.SeriesCollection().Item(3).Delete(); return Convert.ToInt32(chart.SeriesCollection().Count); }));
        probes.Add(ProbeRead("chart.ChartTitle.Text.set", () => { chart.ChartTitle.Text = "Budget allocation"; return Convert.ToString(chart.ChartTitle.Text); }));
        probes.Add(ProbeRead("workbook.cell.Value2.set", () => {
          dynamic sheet = chart.ChartData.Workbook.Worksheets.Item(1); double before = Convert.ToDouble(sheet.Range("B2").Value2); sheet.Range("B2").Value2 = -2;
          object after = sheet.Range("B2").Value2, values = chart.SeriesCollection().Item(1).Values; sheet.Range("B2").Value2 = before;
          return new { after = after, chartValues = values };
        }));
        dynamic floating = null;
        probes.Add(ProbeRead("shape.ConvertToShape", () => { floating = shape.ConvertToShape(); return floating != null; }));
        if (floating != null) {
          probes.Add(ProbeRead("floating.ID", () => Convert.ToInt32(floating.ID)));
          probes.Add(ProbeRead("floating.Name", () => Convert.ToString(floating.Name)));
          probes.Add(ProbeRead("floating.HasChart", () => Convert.ToInt32(floating.HasChart)));
          probes.Add(ProbeRead("floating.Anchor.WordOpenXML", () => ProbeXml(floating.Anchor)));
        }
      }
      Console.WriteLine(json.Serialize(new { kind = "fixture-result", scope = "chart-probe", provider = Provider(), probes = probes, wordVersion = Convert.ToString(word.Version), wordBuild = Convert.ToString(word.Build) })); return 0;
    } catch (Exception error) { Console.WriteLine(json.Serialize(new { kind = "fixture-error", scope = "chart-probe", hresult = "0x" + error.HResult.ToString("X8"), error = error.GetType().Name, processId = pid })); return 1; }
    finally {
      if (document != null) { try { document.Close(0); } catch {} }
      if (owned && word != null) { try { word.Quit(0); } catch {} }
      try { if (document != null && Marshal.IsComObject(document)) Marshal.FinalReleaseComObject(document); } catch {}
      try { if (word != null && Marshal.IsComObject(word)) Marshal.FinalReleaseComObject(word); } catch {}
    }
  }
  static Dictionary<string, object> Expected(Target target) {
    var snapshot = ObjectMap(Inspect(target)); snapshot["textHash"] = Hash(Convert.ToString(snapshot["text"])); return snapshot;
  }
  static void Require(bool value, string message) { if (!value) throw new Exception("Fixture failed: " + message); }
  static int Fixtures(bool paragraphOnly) {
    // Compiled only into a separate development fixture executable. The shipping helper cannot create Word.
    var existing = new HashSet<int>(); foreach (var process in Process.GetProcesses()) { existing.Add(process.Id); process.Dispose(); }
    dynamic word = null, document = null; bool owned = false; uint pid = 0;
    var passed = new List<string>(); var timings = new Dictionary<string, long>();
    try {
      word = Activator.CreateInstance(Type.GetTypeFromProgID("Word.Application", true));
      Require(Convert.ToInt32(word.Documents.Count) == 0, "new automation instance has no existing documents");
      document = word.Documents.Add();
      IntPtr hwnd = new IntPtr(Convert.ToInt64(document.Windows.Item(1).Hwnd)); pid = ProcessOf(hwnd);
      Require(!existing.Contains((int)pid), "fixture Word process is separate from every pre-existing Word process");
      owned = true; word.Visible = false; word.DisplayAlerts = 0;
      Console.WriteLine(json.Serialize(new { kind = "fixture-owned", processId = pid }));
      string original = "Unchanged lead.\rRevenue increased by 12%.\rRevenue increased by 12%.\rUnchanged tail.\r";
      document.Content.Text = original; document.Content.Font.Name = "Calibri"; document.Content.Font.Size = 11;
      original = Convert.ToString(document.Content.Text);
      dynamic range = document.Paragraphs.Item(2).Range.Duplicate; range.End = Convert.ToInt32(range.End) - 1;
      var target = new Target { Id = Guid.NewGuid().ToString(), DocumentId = Guid.NewGuid().ToString(), Kind = "paragraph", Document = document, Range = range, ProcessId = pid, ViewWindow = hwnd, WindowId = RootWindow(hwnd).ToInt64().ToString(), Expires = DateTime.UtcNow.AddMinutes(1) };
      targets.Add(target.Id, target);
      Require(Convert.ToBoolean(ObjectMap(ObjectMap(Inspect(target))["metadata"])["supported"]), "plain selected range supported");
      IntPtr foreground = GetForegroundWindow();
      var command = new Dictionary<string, object> { { "editId", "fixture-paragraph-1" }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", "Revenue grew by 12%." } };
      Apply(target, command);
      int origin = Convert.ToInt32(target.Range.Start);
      // The retained range has its new length now; the old phrase length defines its original extent.
      string expectedDocument = original.Substring(0, origin) + "Revenue grew by 12%." + original.Substring(origin + "Revenue increased by 12%.".Length);
      Require(Convert.ToString(document.Content.Text) == expectedDocument, "only the captured repeated paragraph changes");
      Require(GetForegroundWindow() == foreground, "native paragraph edit preserves foreground window");
      Apply(target, command); Require(Convert.ToString(document.Content.Text).Contains("Revenue increased by 12%."), "duplicate edit does not touch repeated paragraph");
      passed.Add("original-range-only; repeated-paragraph; duplicate-id; no-focus-change");
      Apply(target, new Dictionary<string, object> { { "editId", "fixture-paragraph-undo" }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", "Revenue increased by 12%." } });
      Require(Convert.ToString(document.Content.Text) == original, "conditional text reversal preserves all other text"); passed.Add("paragraph-reverse-patch");
      var stale = Expected(target); target.Range.Text = "A later user edit.";
      try { Apply(target, new Dictionary<string, object> { { "editId", "fixture-stale-change" }, { "operation", "paragraph.replace" }, { "expected", stale }, { "text", "Must never apply." } }); throw new Exception("Stale edit dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_CONFLICT", "stale range refused before mutation"); }
      Require(Convert.ToString(target.Range.Text) == "A later user edit.", "stale reversal keeps later user work"); passed.Add("stale-range-conflict");
      document.TrackRevisions = true; Require(!Convert.ToBoolean(ObjectMap(ObjectMap(Inspect(target))["metadata"])["supported"]), "tracked-change policy produces suggestions only"); document.TrackRevisions = false; passed.Add("track-revisions-refused");
      target.Range.Text = "Harga meningkat 12% — café 😀.";
      Apply(target, new Dictionary<string, object> { { "editId", "fixture-unicode-edit" }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", "Harga naik 12% — café 😁." } });
      Require(Convert.ToString(target.Range.Text) == "Harga naik 12% — café 😁.", "Unicode text and surrogate pairs remain intact"); passed.Add("unicode-and-surrogate-pairs");
      target.Range.Text = "Quarterly revenue for North rose by 12% despite higher costs.";
      target.Range.Font.Bold = 0; target.Range.Font.Italic = 0; target.Range.Font.Underline = 0; target.Range.HighlightColorIndex = 0;
      target.BaseFormatKey = null;
      string richBefore = Convert.ToString(target.Range.Text); origin = Convert.ToInt32(target.Range.Start);
      dynamic north = target.Range.Duplicate; north.SetRange(origin + richBefore.IndexOf("North"), origin + richBefore.IndexOf("North") + 5); north.Font.Bold = -1;
      dynamic costs = target.Range.Duplicate; costs.SetRange(origin + richBefore.IndexOf("higher costs"), origin + richBefore.IndexOf("higher costs") + 12); costs.Font.Italic = -1;
      dynamic value = target.Range.Duplicate; value.SetRange(origin + richBefore.IndexOf("12%"), origin + richBefore.IndexOf("12%") + 3); value.Font.Color = 255; value.Font.Underline = 1; value.HighlightColorIndex = 7;
      target.Range.ParagraphFormat.LeftIndent = 18; target.Range.ParagraphFormat.SpaceAfter = 9;
      var measured = Stopwatch.StartNew(); var richSnapshot = ObjectMap(Inspect(target)); timings["mixedCaptureMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToBoolean(ObjectMap(richSnapshot["metadata"])["supported"]), "ordinary mixed-font paragraph supports gap rewrites");
      string richPreservation = Convert.ToString(richSnapshot["preservationHash"]), wholeRichBefore = Convert.ToString(document.Content.Text);
      string richAfter = "Revenue for North grew by 12%, even with higher costs.";
      var richExpected = Expected(target); measured.Restart();
      Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-edit" }, { "operation", "paragraph.replace" }, { "expected", richExpected }, { "text", richAfter } }); timings["mixedApplyMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToString(target.Range.Text) == richAfter, "multiple gaps rewrite around exact styled anchors");
      Require(Convert.ToString(ObjectMap(Inspect(target))["preservationHash"]) == richPreservation, "styled anchors and paragraph properties preserved");
      Require(Convert.ToString(document.Content.Text) == wholeRichBefore.Substring(0, origin) + richAfter + wholeRichBefore.Substring(origin + richBefore.Length), "rich rewrite changes only original range");
      Require(GetForegroundWindow() == foreground, "rich rewrite keeps foreground focus");
      north.SetRange(origin + richAfter.IndexOf("North"), origin + richAfter.IndexOf("North") + 5); Require(Convert.ToInt32(north.Font.Bold) == -1, "bold phrase stays bold");
      costs.SetRange(origin + richAfter.IndexOf("higher costs"), origin + richAfter.IndexOf("higher costs") + 12); Require(Convert.ToInt32(costs.Font.Italic) == -1, "italic phrase stays italic");
      value.SetRange(origin + richAfter.IndexOf("12%"), origin + richAfter.IndexOf("12%") + 3); Require(Convert.ToInt32(value.Font.Color) == 255 && Convert.ToInt32(value.Font.Underline) == 1 && Convert.ToInt32(value.HighlightColorIndex) == 7, "color underline and highlight preserved");
      Require(Convert.ToDouble(target.Range.ParagraphFormat.LeftIndent) == 18 && Convert.ToDouble(target.Range.ParagraphFormat.SpaceAfter) == 9, "indent and spacing preserved");
      passed.Add("mixed-font-gap-rewrite; bold-italic-color-underline-highlight; paragraph-indent-spacing; original-range; no-focus-change");
      richExpected = Expected(target); measured.Restart();
      Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-undo" }, { "operation", "paragraph.replace" }, { "expected", richExpected }, { "text", richBefore } }); timings["mixedUndoMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToString(document.Content.Text) == wholeRichBefore && Convert.ToString(ObjectMap(Inspect(target))["preservationHash"]) == richPreservation, "rich conditional reversal restores text and tested formatting"); passed.Add("mixed-font-conditional-reversal");
      int edge = 0;
      foreach (string edgeText in new [] { "North's quarterly revenue rose 12% despite higher costs.", "Revenue for North grew by 12%, even with higher costs" }) {
        Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-edge-" + edge }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", edgeText } });
        Require(Convert.ToString(target.Range.Text) == edgeText && Convert.ToString(ObjectMap(Inspect(target))["preservationHash"]) == richPreservation, "leading/trailing plain-text deletion preserves styled anchors");
        Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-edge-undo-" + edge++ }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", richBefore } });
        Require(Convert.ToString(document.Content.Text) == wholeRichBefore && Convert.ToString(ObjectMap(Inspect(target))["preservationHash"]) == richPreservation, "conditional reversal restores leading/trailing base formatting");
      }
      passed.Add("leading-trailing-plain-text-delete-and-conditional-reinsert");
      foreach (string invalid in new [] { richBefore.Replace("North", "South"), richBefore.Replace("North", "North North"), "Revenue for higher costs grew by 12%, even with North.", richBefore.Replace(" despite ", "") }) {
        string beforeInvalid = Convert.ToString(target.Range.WordOpenXML);
        try { Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-refusal-" + Guid.NewGuid().ToString() }, { "operation", "paragraph.replace" }, { "expected", Expected(target) }, { "text", invalid } }); throw new Exception("Invalid styled-anchor rewrite dispatched."); }
        catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED" && !failure.Uncertain, "styled-anchor violation refused before mutation"); }
        Require(Convert.ToString(target.Range.WordOpenXML) == beforeInvalid, "refused styled-anchor proposal changes no text or formatting");
      }
      passed.Add("changed-duplicate-relocated-anchor-and-removed-gap-refused");
      var formattedStale = Expected(target); north.Font.Bold = 0;
      try { Apply(target, new Dictionary<string, object> { { "editId", "fixture-rich-stale" }, { "operation", "paragraph.replace" }, { "expected", formattedStale }, { "text", richAfter } }); throw new Exception("Stale formatting dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_CONFLICT" && !failure.Uncertain, "format-only stale change refused"); } passed.Add("format-only-stale-conflict");
      if (paragraphOnly) {
        Console.WriteLine(json.Serialize(new { kind = "fixture-result", scope = "paragraph", provider = Provider(), passed = passed, timings = timings, wordVersion = Convert.ToString(word.Version), wordBuild = Convert.ToString(word.Build), processId = pid })); return 0;
      }
      Require(Provider() == "microsoft-word" || Provider() == "wps", "full chart qualification requires a supported Office provider");
      dynamic insertion = document.Range(Convert.ToInt32(document.Content.End) - 1, Convert.ToInt32(document.Content.End) - 1);
      Console.WriteLine(json.Serialize(new { kind = "fixture-stage", stage = "chart-create", wordVersion = Convert.ToString(word.Version), wordBuild = Convert.ToString(word.Build), readOnly = Convert.ToBoolean(document.ReadOnly), protection = Convert.ToInt32(document.ProtectionType) }));
      dynamic shape = document.InlineShapes.AddChart2(-1, 57, insertion, false);
      Console.WriteLine(json.Serialize(new { kind = "fixture-stage", stage = "chart-data" }));
      dynamic chart = shape.Chart; dynamic series = chart.SeriesCollection();
      while (Convert.ToInt32(series.Count) > 1) series.Item(Convert.ToInt32(series.Count)).Delete();
      dynamic sheet = null;
      if (Provider() == "wps") {
        // Array-valued setters silently do nothing on this WPS build; prepare the owned embedded workbook.
        sheet = chart.ChartData.Workbook.Worksheets.Item(1);
        sheet.Range("B1").Value2 = "Share";
        string [] categories = new [] { "North", "South", "West", "East" }; double [] values = new double [] { 2, 3, 5, 7 };
        for (int i = 0; i < values.Length; i++) { sheet.Range("A" + (i + 2)).Value2 = categories[i]; sheet.Range("B" + (i + 2)).Value2 = values[i]; }
        Require(json.Serialize((object)series.Item(1).Values) == json.Serialize(values) && json.Serialize((object)series.Item(1).XValues) == json.Serialize(categories), "WPS fixture source data is actually prepared");
      } else {
        series.Item(1).Values = new double [] { 2, 3, 5 }; series.Item(1).XValues = new string [] { "North", "South", "West" }; series.Item(1).Name = "Share";
        chart.HasTitle = true; chart.ChartTitle.Text = "Budget allocation";
      }
      var chartTarget = new Target { Id = Guid.NewGuid().ToString(), DocumentId = target.DocumentId, Kind = "chart", ChartInline = true, Document = document, Shape = shape, ProcessId = pid, ViewWindow = hwnd, WindowId = target.WindowId, Expires = DateTime.UtcNow.AddMinutes(1) };
      targets.Add(chartTarget.Id, chartTarget);
      ChartParserFixtures(); passed.Add("chart-source-exact-binding; external-traversal-duplicate-missing-and-DTD-refused");
      dynamic secondInsertion = document.Range(Convert.ToInt32(document.Content.End) - 1, Convert.ToInt32(document.Content.End) - 1);
      dynamic secondShape = document.InlineShapes.AddChart2(-1, 51, secondInsertion, false);
      var secondTarget = new Target { Id = Guid.NewGuid().ToString(), DocumentId = target.DocumentId, Kind = "chart", ChartInline = true, Document = document, Shape = secondShape, ProcessId = pid, ViewWindow = hwnd, WindowId = target.WindowId, Expires = DateTime.UtcNow.AddMinutes(1) };
      string secondProperties = Hash(json.Serialize(ChartData(secondTarget))), documentTextBeforeChart = Convert.ToString(document.Content.Text);
      var secondExpected = Expected(secondTarget);
      try { Apply(secondTarget, new Dictionary<string, object> { { "editId", "fixture-multi-series-refusal" }, { "operation", "chart.setType" }, { "expected", secondExpected }, { "chartType", 5 } }); throw new Exception("Multiseries pie dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED" && !failure.Uncertain, "multi-series chart refused before mutation"); } passed.Add("native-multi-series-refused");
      string properties = Hash(json.Serialize(ChartData(chartTarget))); foreground = GetForegroundWindow();
      var chartExpected = Expected(chartTarget); measured.Restart();
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-chart-pie" }, { "operation", "chart.setType" }, { "expected", chartExpected }, { "chartType", 5 } }); timings["chartApplyMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToInt32(chart.ChartType) == 5 && properties == Hash(json.Serialize(ChartData(chartTarget))), "same native chart retains data/title/geometry/anchor");
      Require(GetForegroundWindow() == foreground, "native chart conversion preserves foreground window"); passed.Add("native-chart-pie; data-title-geometry-anchor; no-focus-change");
      Require(Convert.ToInt32(secondShape.Chart.ChartType) == 51 && secondProperties == Hash(json.Serialize(ChartData(secondTarget))) && Convert.ToString(document.Content.Text) == documentTextBeforeChart, "the unrelated chart and document text are unchanged"); passed.Add("native-chart-original-object-only; unrelated-chart-and-text-unchanged");
      chartExpected = Expected(chartTarget); measured.Restart();
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-chart-reverse" }, { "operation", "chart.restoreType" }, { "expected", chartExpected }, { "chartType", 57 } }); timings["chartUndoMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToInt32(chart.ChartType) == 57 && properties == Hash(json.Serialize(ChartData(chartTarget))), "chart reversal preserves tested common properties"); passed.Add("chart-reverse-common-properties");
      if (sheet != null) sheet.Range("B2").Value2 = -2; else series.Item(1).Values = new double [] { -2, 3, 5 };
      try { Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-negative-pie" }, { "operation", "chart.setType" }, { "expected", Expected(chartTarget) }, { "chartType", 5 } }); throw new Exception("Negative pie dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED" && Convert.ToInt32(chart.ChartType) == 57, "negative pie refused before mutation"); } passed.Add("negative-pie-refused");
      if (sheet != null) { for (int i = 2; i <= 5; i++) sheet.Range("B" + i).Value2 = 0; }
      else series.Item(1).Values = new double [] { 0, 0, 0 };
      try { Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-zero-pie" }, { "operation", "chart.setType" }, { "expected", Expected(chartTarget) }, { "chartType", 5 } }); throw new Exception("Zero pie dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_UNSUPPORTED" && !failure.Uncertain && Convert.ToInt32(chart.ChartType) == 57, "zero-total pie refused before mutation"); } passed.Add("zero-total-pie-refused");
      if (sheet != null) { sheet.Range("B2").Value2 = 2; sheet.Range("B3").Value2 = 3; sheet.Range("B4").Value2 = 5; sheet.Range("B5").Value2 = 7; }
      else series.Item(1).Values = new double [] { 2, 3, 5 };
      var staleChart = Expected(chartTarget); shape.Width = Convert.ToDouble(shape.Width) + 1;
      try { Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-chart-stale" }, { "operation", "chart.setType" }, { "expected", staleChart }, { "chartType", 5 } }); throw new Exception("Stale chart dispatched."); }
      catch (NativeFailure failure) { Require(failure.Code == "TARGET_CONFLICT" && !failure.Uncertain && Convert.ToInt32(chart.ChartType) == 57, "later chart geometry prevents stale native dispatch"); } passed.Add("native-chart-stale-geometry-conflict");
      dynamic floatingShape = shape.ConvertToShape(); chartTarget.Shape = floatingShape; chartTarget.ChartInline = false;
      floatingShape.Left = 12; floatingShape.Top = 24;
      string floatingProperties = Hash(json.Serialize(ChartData(chartTarget))), textBeforeFloating = Convert.ToString(document.Content.Text), secondAfterConversion = Hash(json.Serialize(ChartData(secondTarget))); foreground = GetForegroundWindow();
      chartExpected = Expected(chartTarget); measured.Restart();
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-floating-chart-pie" }, { "operation", "chart.setType" }, { "expected", chartExpected }, { "chartType", 5 } }); timings["floatingChartApplyMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToInt32(floatingShape.Chart.ChartType) == 5 && floatingProperties == Hash(json.Serialize(ChartData(chartTarget))), "floating chart data/title/width/height/anchor/left/top/drawing identity preserved");
      Require(secondAfterConversion == Hash(json.Serialize(ChartData(secondTarget))) && Convert.ToInt32(secondShape.Chart.ChartType) == 51 && Convert.ToString(document.Content.Text) == textBeforeFloating && GetForegroundWindow() == foreground, "floating edit leaves the unrelated chart/text/focus unchanged");
      chartExpected = Expected(chartTarget); measured.Restart();
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-floating-chart-undo" }, { "operation", "chart.restoreType" }, { "expected", chartExpected }, { "chartType", 57 } }); timings["floatingChartUndoMs"] = measured.ElapsedMilliseconds;
      Require(Convert.ToInt32(floatingShape.Chart.ChartType) == 57 && floatingProperties == Hash(json.Serialize(ChartData(chartTarget))), "floating reversal preserves tested common properties");
      passed.Add("floating-native-chart-pie-and-reversal; exact-drawing-binding; position-and-identity-preserved; unrelated-chart-text-focus-unchanged");
      floatingShape.Chart.ChartType = 51;
      string columnProperties = Hash(json.Serialize(ChartData(chartTarget)));
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-column-chart-pie" }, { "operation", "chart.setType" }, { "expected", Expected(chartTarget) }, { "chartType", 5 } });
      Require(Convert.ToInt32(floatingShape.Chart.ChartType) == 5 && columnProperties == Hash(json.Serialize(ChartData(chartTarget))), "single-series 2D column converts through the same native path");
      Apply(chartTarget, new Dictionary<string, object> { { "editId", "fixture-column-chart-undo" }, { "operation", "chart.restoreType" }, { "expected", Expected(chartTarget) }, { "chartType", 51 } });
      Require(Convert.ToInt32(floatingShape.Chart.ChartType) == 51 && columnProperties == Hash(json.Serialize(ChartData(chartTarget))), "2D column reversal retains tested common properties"); passed.Add("native-2D-column-pie-and-reversal");
      Console.WriteLine(json.Serialize(new { kind = "fixture-result", scope = "paragraph-and-native-chart", provider = Provider(), passed = passed, timings = timings, wordVersion = Convert.ToString(word.Version), wordBuild = Convert.ToString(word.Build), processId = pid }));
      return 0;
    } catch (Exception error) { Console.WriteLine(json.Serialize(new { kind = "fixture-error", error = error.Message, passed = passed, processId = pid })); return 1; }
      finally {
        object rawDocument = document, rawWord = word;
        targets.Clear(); edits.Clear();
        if (document != null) { try { document.Close(0); } catch {} }
        if (owned && word != null) { try { word.Quit(0); } catch {} }
        try { if (rawDocument != null && Marshal.IsComObject(rawDocument)) Marshal.FinalReleaseComObject(rawDocument); } catch {}
        try { if (rawWord != null && Marshal.IsComObject(rawWord)) Marshal.FinalReleaseComObject(rawWord); } catch {}
      }
  }
#endif
  [STAThread] public static int Main(string [] args) {
#if MIDNIGHT_WORD_FIXTURES
    if (args.Length == 1 && args[0] == "--fixture-chart-probe") return ChartProbe();
    if (args.Length == 1 && (args[0] == "--fixture" || args[0] == "--fixture-paragraph")) return Fixtures(args[0] == "--fixture-paragraph");
    if (args.Length == 1 && args[0] == "--fixture-workflow") return Workflow();
#endif
    return RunProtocol();
  }
  static int RunProtocol() {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    using (var marshal = new Control()) {
      marshal.CreateControl(); var handle = marshal.Handle;
      var reader = new Thread(() => {
        string line;
        while ((line = Console.ReadLine()) != null) { string request = line; marshal.BeginInvoke((Action)(() => Respond(request))); }
        marshal.BeginInvoke((Action)(() => Application.ExitThread()));
      }) { IsBackground = true };
      using (var timer = new System.Windows.Forms.Timer { Interval = 2000 }) {
        timer.Tick += (sender, eventArgs) => {
          foreach (string id in new List<string>(targets.Keys)) if (targets[id].Expires <= DateTime.UtcNow) targets.Remove(id);
          foreach (string id in new List<string>(edits.Keys)) if (edits[id].Expires <= DateTime.UtcNow) edits.Remove(id);
          if (targets.Count == 0 && DateTime.UtcNow - lastRequest > TimeSpan.FromMinutes(2)) Application.ExitThread();
        };
        timer.Start(); reader.Start(); Application.Run();
      }
    }
    return 0;
  }
}
