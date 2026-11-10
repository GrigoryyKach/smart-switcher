using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SmartSwitcher
{
    /// <summary>Проверка детектора на списках слов: правильно набранные не трогаем, набранные не в той раскладке — исправляем.</summary>
    static class SelfTest
    {
        public static int Run(string[] args)
        {
            var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            string dir = args.Length > 1 ? args[1] : "helper/test";
            int sens = args.Length > 2 ? int.Parse(args[2]) : 5;
            var det = Detector.LoadEmbedded();
            det.SetSensitivity(sens);
            o.WriteLine("dict: en={0} ru={1}; sensitivity={2} threshold={3:F2} floor={4:F2}", det.Dict[0].Count, det.Dict[1].Count, sens, det.Threshold, det.Floor);
            o.WriteLine("calibration: " + det.CalibrationInfo());

            // коллизии словарей: слово одного языка, которое в другой раскладке тоже словарное
            var coll = new List<string>();
            for (int L = 0; L < 2; L++)
                foreach (var w in det.Dict[L])
                {
                    var s = Layouts.StrokesFor(w, L);
                    if (s == null) continue;
                    bool v; string alt = Detector.Clean(Layouts.Text(s, 1 - L), 1 - L, out v);
                    if (v && det.Dict[1 - L].Contains(alt)) coll.Add(w + "↔" + alt);
                }
            o.WriteLine("коллизии словарей ({0}): {1}", coll.Count, string.Join(" ", coll.Take(60)));

            bool failed = false;
            foreach (bool useDict in new[] { true, false })
            {
                det.UseDict = useDict;
                o.WriteLine();
                o.WriteLine(useDict ? "=== со словарём ===" : "=== только n-граммы (проверка обобщения) ===");
                for (int L = 0; L < 2; L++)
                {
                    string file = Path.Combine(dir, (L == 0 ? "en" : "ru") + "_test.txt");
                    var words = File.ReadAllText(file, Encoding.UTF8).Split(new[] { ' ', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries)
                                    .Where(w => !w.StartsWith("#")).ToList();
                    if (useDict) words.AddRange(det.Dict[L].Where(w => w.Length > 1));
                    int fp = 0, fn = 0, total = 0;
                    var fpList = new List<string>(); var fnList = new List<string>();
                    foreach (var w in words)
                    {
                        var s = Layouts.StrokesFor(w, L);
                        if (s == null) continue;
                        total++;
                        var right = det.Analyze(s, L);       // набрано правильно
                        var wrong = det.Analyze(s, 1 - L);   // набрано не в той раскладке
                        if (right.Convert) { fp++; if (fpList.Count < 40) fpList.Add(w + string.Format("({0:F1}/{1:F1})", right.CurScore, right.AltScore)); }
                        if (!wrong.Convert && w.Length >= 3) { fn++; if (fnList.Count < 40) fnList.Add(w + string.Format("({0:F1}/{1:F1})", wrong.AltScore, wrong.CurScore)); }
                    }
                    o.WriteLine("[{0}] слов {1}: ложных исправлений {2} ({3:P1}), пропусков {4} ({5:P1})",
                        L == 0 ? "EN" : "RU", total, fp, (double)fp / total, fn, (double)fn / total);
                    if (fpList.Count > 0) o.WriteLine("   ложные: " + string.Join(" ", fpList));
                    if (fnList.Count > 0) o.WriteLine("   пропуски: " + string.Join(" ", fnList));
                    if (useDict && (double)fp / total > 0.01) failed = true;
                }
            }

            det.UseDict = true;
            o.WriteLine();
            o.WriteLine("Технические слова (в EN не должны исправляться):");
            string tech = "npm git src cfg http https xml json tsx jsx kubectl useState onClick ctrl alt env dev prod localhost github api sql html css cmd exe dll px rgb utf usb wifi bluetooth zip pdf jpg png mp3 xyz qwerty asdf lol omg btw imho idk ok thx pls";
            var bad = new List<string>();
            foreach (var w in tech.Split(' '))
            {
                var s = Layouts.StrokesFor(w, 0);
                if (s != null && det.Analyze(s, 0).Convert) bad.Add(w + "→" + Layouts.Text(s, 1));
            }
            o.WriteLine(bad.Count == 0 ? "   все ок" : "   исправились бы: " + string.Join(" ", bad));
            return failed ? 1 : 0;
        }
    }

    /// <summary>
    /// Сквозной тест: открывает своё окно с полем ввода, ставит настоящий хук и «печатает» через SendInput.
    /// Печатает только пока наше окно на переднем плане — иначе останавливается.
    /// </summary>
    static class E2E
    {
        class Case { public string Name, Layout, Keys, Expected; }

        public static int Run()
        {
            var o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
            IntPtr enHkl = Layouts.FindHkl(Layouts.EN), ruHkl = Layouts.FindHkl(Layouts.RU);
            if (enHkl == IntPtr.Zero || ruHkl == IntPtr.Zero) { o.WriteLine("SKIP: в системе нет раскладок EN и RU одновременно"); return 3; }

            // Клавиши описываются символами, как они выглядят в EN-раскладке. '|' — Pause, '^' — CapsLock.
            var cases = new List<Case> {
                new Case { Name = "привет из EN", Layout = "en", Keys = "ghbdtn ", Expected = "привет " },
                new Case { Name = "правильное RU не трогаем", Layout = "ru", Keys = "ghbdtn ", Expected = "привет " },
                new Case { Name = "hello из RU", Layout = "ru", Keys = "hello ", Expected = "hello " },
                new Case { Name = "английский не трогаем", Layout = "en", Keys = "hello world ", Expected = "hello world " },
                new Case { Name = "фраза", Layout = "en", Keys = "ghbdtn rfr ltkf ", Expected = "привет как дела " },
                new Case { Name = "я тебя люблю", Layout = "en", Keys = "z nt,z k.,k. ", Expected = "я тебя люблю " },
                new Case { Name = "заглавная", Layout = "en", Keys = "Ghbdtn ", Expected = "Привет " },
                new Case { Name = "капсом", Layout = "en", Keys = "GHBDTN ", Expected = "ПРИВЕТ " },
                new Case { Name = "CapsLock", Layout = "en", Keys = "^ghbdtn^ ", Expected = "ПРИВЕТ " },
                new Case { Name = "отмена Pause", Layout = "en", Keys = "ghbdtn |", Expected = "ghbdtn " },
                new Case { Name = "ручное исправление слова", Layout = "en", Keys = "fsdf|", Expected = "аыва" },
                new Case { Name = "ручное исправление после пробела", Layout = "ru", Keys = "ghbdtn |", Expected = "ghbdtn " },
                new Case { Name = "Enter как триггер", Layout = "en", Keys = "ghbdtn\n", Expected = "привет\r\n" },
                new Case { Name = "запятая RU", Layout = "en", Keys = "ghbdtn? rfr ", Expected = "привет, как " },
                new Case { Name = "бэкспейс внутри слова", Layout = "en", Keys = "ghbdtnn\b ", Expected = "привет " },
                new Case { Name = "быстрый набор", Layout = "en", Keys = "!ghbdtn vbh ", Expected = "привет мир " },
            };

            var form = new Form { Text = "SmartSwitcher E2E", Width = 600, Height = 200, TopMost = true, StartPosition = FormStartPosition.CenterScreen };
            var box = new TextBox { Multiline = true, Dock = DockStyle.Fill, Font = new System.Drawing.Font("Segoe UI", 14) };
            form.Controls.Add(box);
            var engine = new Engine(Detector.LoadEmbedded());
            engine.Cfg.Sound = false;
            engine.ApplyConfig();
            int failures = 0;

            form.Shown += delegate
            {
                engine.Install();
                // трюк, чтобы Windows разрешила вывести окно на передний план
                Native.Send(new List<Native.INPUT> { Native.Key(0x12, false, Engine.TAG), Native.Key(0x12, true, Engine.TAG) });
                Native.SetForegroundWindow(form.Handle);
                form.Activate(); box.Focus();

                var worker = new Thread(() =>
                {
                    Thread.Sleep(600);
                    foreach (var c in cases)
                    {
                        if (Native.GetForegroundWindow() != form.Handle) { o.WriteLine("СТОП: окно теста потеряло фокус"); failures++; break; }
                        form.Invoke(new Action(() =>
                        {
                            box.Clear();
                            Native.ActivateKeyboardLayout(c.Layout == "en" ? enHkl : ruHkl, 0);
                            if (Native.GetKeyState(0x14) % 2 != 0) Native.Send(Tap(0x14));
                        }));
                        Thread.Sleep(150);
                        bool fast = c.Keys.StartsWith("!");
                        foreach (char ch in fast ? c.Keys.Substring(1) : c.Keys)
                        {
                            if (Native.GetForegroundWindow() != form.Handle) break;
                            Native.Send(KeysFor(ch));
                            Thread.Sleep(fast ? 1 : 35);
                        }
                        Thread.Sleep(350);
                        string got = (string)form.Invoke(new Func<string>(() => box.Text));
                        bool ok = got == c.Expected;
                        if (!ok) failures++;
                        o.WriteLine("{0} {1}: ожидали «{2}», получили «{3}»", ok ? "OK  " : "FAIL", c.Name,
                            c.Expected.Replace("\r\n", "⏎"), got.Replace("\r\n", "⏎"));
                    }
                    form.Invoke(new Action(() => { engine.Uninstall(); form.Close(); }));
                });
                worker.IsBackground = true;
                worker.Start();
            };
            Application.Run(form);
            o.WriteLine(failures == 0 ? "ВСЕ ТЕСТЫ ПРОЙДЕНЫ" : "ПРОВАЛЕНО: " + failures);
            return failures == 0 ? 0 : 1;
        }

        static List<Native.INPUT> Tap(int vk)
        {
            return new List<Native.INPUT> { Native.Key(vk, false, IntPtr.Zero), Native.Key(vk, true, IntPtr.Zero) };
        }

        static List<Native.INPUT> KeysFor(char ch)
        {
            if (ch == ' ') return Tap(0x20);
            if (ch == '\n') return Tap(0x0D);
            if (ch == '\b') return Tap(0x08);
            if (ch == '|') return Tap(0x13);
            if (ch == '^') return Tap(0x14);
            var s = Layouts.StrokesFor(ch.ToString(), Layouts.EN)[0];
            var list = new List<Native.INPUT>();
            if (s.Shift) list.Add(Native.Key(0xA0, false, IntPtr.Zero));
            list.AddRange(Tap(s.Vk));
            if (s.Shift) list.Add(Native.Key(0xA0, true, IntPtr.Zero));
            return list;
        }
    }
}
