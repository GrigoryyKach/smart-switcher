using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace SmartSwitcher
{
    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--selftest") return SelfTest.Run(args);
            if (args.Length > 0 && args[0] == "--e2e") return E2E.Run();

            bool created;
            using (var mutex = new Mutex(true, "SmartSwitcherHelper_SingleInstance", out created))
            {
                if (!created) return 2;
                new Host().Run();
            }
            return 0;
        }
    }

    /// <summary>Связь с Electron: JSON-строки через stdin/stdout.</summary>
    class Host
    {
        readonly JavaScriptSerializer ser = new JavaScriptSerializer();
        readonly object outLock = new object();
        StreamWriter output;
        Engine engine;

        public void Run()
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            engine = new Engine(Detector.LoadEmbedded());
            engine.Emit = Send;

            var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            var t = new Thread(() =>
            {
                try
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        string l = line;
                        engine.Ctl.BeginInvoke(new Action(() => Handle(l)));
                    }
                }
                catch { }
                // Electron закрылся — выходим, чтобы не оставлять хук
                try { engine.Ctl.BeginInvoke(new Action(Application.Exit)); } catch { Environment.Exit(0); }
            });
            t.IsBackground = true;
            t.Start();

            engine.Install();
            Send(new Dictionary<string, object> {
                { "type", "ready" },
                { "layouts", new Dictionary<string, object> {
                    { "en", Layouts.FindHkl(Layouts.EN) != IntPtr.Zero },
                    { "ru", Layouts.FindHkl(Layouts.RU) != IntPtr.Zero } } },
                { "dict", new Dictionary<string, object> { { "en", engine.Det.Dict[0].Count }, { "ru", engine.Det.Dict[1].Count } } } });
            engine.ForceReportLayout();
            Application.Run();
            engine.Uninstall();
        }

        void Send(Dictionary<string, object> d)
        {
            string s = ser.Serialize(d);
            lock (outLock) { try { output.WriteLine(s); } catch { } }
        }

        void Handle(string line)
        {
            Dictionary<string, object> d;
            try { d = ser.Deserialize<Dictionary<string, object>>(line); } catch { return; }
            if (d == null) return;
            object typeObj, id;
            d.TryGetValue("type", out typeObj);
            d.TryGetValue("id", out id);
            switch (typeObj as string)
            {
                case "config":
                    engine.Cfg.Apply(d);
                    engine.ApplyConfig();
                    break;
                case "listApps":
                    Send(new Dictionary<string, object> { { "type", "apps" }, { "id", id }, { "list", engine.ListApps() } });
                    break;
                case "analyze":
                    {
                        object textObj; d.TryGetValue("text", out textObj);
                        var r = Analyze((textObj as string) ?? "");
                        r["type"] = "analysis"; r["id"] = id;
                        Send(r);
                        break;
                    }
                case "quit":
                    Application.Exit();
                    break;
            }
        }

        Dictionary<string, object> Analyze(string text)
        {
            var r = new Dictionary<string, object>();
            text = text.Trim();
            int lang = Layouts.DetectTextLang(text);
            var strokes = Layouts.StrokesFor(text, lang);
            r["text"] = text;
            r["lang"] = Layouts.LangName(lang);
            if (text.Length == 0 || strokes == null) { r["ok"] = false; r["reason"] = "Введите одно слово из букв (без цифр и пробелов)"; return r; }
            var dec = engine.Det.Analyze(strokes, lang);
            r["ok"] = true;
            r["converted"] = Layouts.Text(strokes, 1 - lang);
            r["cur"] = dec.Cur; r["alt"] = dec.Alt;
            r["curScore"] = Math.Round(dec.CurScore, 2); r["altScore"] = Math.Round(dec.AltScore, 2);
            r["curInDict"] = dec.CurInDict; r["altInDict"] = dec.AltInDict;
            r["convert"] = dec.Convert; r["reason"] = dec.Reason;
            return r;
        }
    }
}
