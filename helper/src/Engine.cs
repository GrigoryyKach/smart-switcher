using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Media;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SmartSwitcher
{
    class Conv
    {
        public string Original, Converted, Kind, Word;
        public int Trigger, From, To;
    }

    /// <summary>
    /// Global keyboard hook: collects the current word, decides on space/Enter whether the layout is right,
    /// and if needed erases the word, switches the layout and types the corrected version.
    /// </summary>
    class Engine
    {
        public static readonly IntPtr TAG = new IntPtr(0x53535731);    // our own key presses: ignored
        public static readonly IntPtr REPLAY = new IntPtr(0x53535732); // replay of key presses deferred during a replacement

        const int VK_BACK = 0x08, VK_TAB = 0x09, VK_RETURN = 0x0D, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12,
                  VK_CAPITAL = 0x14, VK_SPACE = 0x20, VK_LWIN = 0x5B, VK_RWIN = 0x5C, VK_C = 0x43, VK_V = 0x56,
                  VK_LSHIFT = 0xA0, VK_RSHIFT = 0xA1, VK_LCONTROL = 0xA2, VK_RCONTROL = 0xA3, VK_LMENU = 0xA4, VK_RMENU = 0xA5;

        public Config Cfg = new Config();
        public readonly Detector Det;
        public Action<Dictionary<string, object>> Emit = delegate { };
        public readonly Control Ctl;

        Native.HookProc kbProc, msProc;
        IntPtr kbHook = IntPtr.Zero, msHook = IntPtr.Zero;

        readonly List<Stroke> buffer = new List<Stroke>();
        List<Stroke> lastWord; int lastWordLang, lastWordTrigger;
        Conv lastConv;
        bool busy;
        List<Native.INPUT> pending = new List<Native.INPUT>();

        IntPtr lastFg = IntPtr.Zero; bool fgExcluded; string fgProcess = "";
        readonly Dictionary<uint, string> procCache = new Dictionary<uint, string>();

        // double tap of a modifier
        int tapVk, lastTapVk; bool tapClean; int tapDownTime, lastTapTime;

        readonly SoundPlayer click;
        readonly Timer layoutTimer;
        int reportedLang = -2;

        public Engine(Detector det)
        {
            Det = det;
            Ctl = new Control();
            Ctl.CreateControl();
            var h = Ctl.Handle; // make sure the window exists for BeginInvoke
            click = new SoundPlayer(Sound.MakeClick());
            try { click.Load(); } catch { }
            layoutTimer = new Timer { Interval = 250 };
            layoutTimer.Tick += delegate { ReportLayout(); };
            ApplyConfig();
        }

        public void ApplyConfig()
        {
            Det.SetSensitivity(Cfg.Sensitivity);
            Det.MinLength = Math.Max(1, Cfg.MinWordLength);
            Det.Exceptions = Cfg.Exceptions;
            lastFg = IntPtr.Zero; // recompute excluded apps
            ResetAll();
        }

        public void Install()
        {
            kbProc = KbProc; msProc = MsProc;
            IntPtr mod = Native.GetModuleHandle(null);
            kbHook = Native.SetWindowsHookEx(Native.WH_KEYBOARD_LL, kbProc, mod, 0);
            msHook = Native.SetWindowsHookEx(Native.WH_MOUSE_LL, msProc, mod, 0);
            if (kbHook == IntPtr.Zero) throw new Exception("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
            layoutTimer.Start();
        }

        public void Uninstall()
        {
            layoutTimer.Stop();
            if (kbHook != IntPtr.Zero) Native.UnhookWindowsHookEx(kbHook);
            if (msHook != IntPtr.Zero) Native.UnhookWindowsHookEx(msHook);
            kbHook = msHook = IntPtr.Zero;
        }

        // ───────────────────────── hooks ─────────────────────────

        IntPtr KbProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode < 0) return Native.CallNextHookEx(kbHook, nCode, wParam, lParam);
            var k = (Native.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Native.KBDLLHOOKSTRUCT));
            if (k.dwExtraInfo == TAG) return Native.CallNextHookEx(kbHook, nCode, wParam, lParam);

            int msg = wParam.ToInt32();
            bool down = msg == Native.WM_KEYDOWN || msg == Native.WM_SYSKEYDOWN;
            bool up = msg == Native.WM_KEYUP || msg == Native.WM_SYSKEYUP;

            if (busy)
            {
                // A replacement is in progress: defer the key press and replay it right after.
                var i = Native.Key((int)k.vkCode, up, REPLAY);
                i.u.ki.wScan = (ushort)k.scanCode;
                if ((k.flags & Native.LLKHF_EXTENDED) != 0) i.u.ki.dwFlags |= Native.KEYEVENTF_EXTENDEDKEY;
                pending.Add(i);
                return (IntPtr)1;
            }

            bool swallow = false;
            try
            {
                if (down) swallow = OnKeyDown((int)k.vkCode);
                else if (up) OnKeyUp((int)k.vkCode);
            }
            catch (Exception ex) { EmitError(ex); }
            return swallow ? (IntPtr)1 : Native.CallNextHookEx(kbHook, nCode, wParam, lParam);
        }

        IntPtr MsProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                int msg = wParam.ToInt32();
                if (msg == Native.WM_LBUTTONDOWN || msg == Native.WM_RBUTTONDOWN || msg == Native.WM_MBUTTONDOWN || msg == Native.WM_XBUTTONDOWN)
                {
                    ResetAll();
                    tapClean = false; lastTapVk = 0;
                }
            }
            return Native.CallNextHookEx(msHook, nCode, wParam, lParam);
        }

        static bool IsShiftKey(int vk) { return vk == VK_SHIFT || vk == VK_LSHIFT || vk == VK_RSHIFT; }
        static bool IsCtrlKey(int vk) { return vk == VK_CONTROL || vk == VK_LCONTROL || vk == VK_RCONTROL; }
        static bool IsModifier(int vk)
        {
            return IsShiftKey(vk) || IsCtrlKey(vk) || vk == VK_MENU || vk == VK_LMENU || vk == VK_RMENU ||
                   vk == VK_LWIN || vk == VK_RWIN || vk == VK_CAPITAL;
        }

        bool IsTrigger(int vk)
        {
            return (vk == VK_SPACE && Cfg.TriggerSpace) || (vk == VK_RETURN && Cfg.TriggerEnter) || (vk == VK_TAB && Cfg.TriggerTab);
        }

        void ResetAll() { buffer.Clear(); lastWord = null; lastConv = null; }

        bool OnKeyDown(int vk)
        {
            if (!Cfg.Enabled) { ResetAll(); return false; }

            IntPtr fg = Native.GetForegroundWindow();
            if (fg != lastFg)
            {
                ResetAll();
                lastFg = fg;
                fgProcess = ProcessNameOf(fg);
                fgExcluded = Cfg.ExcludedApps.Contains(fgProcess);
            }
            if (fgExcluded) return false;

            // double tap of Shift/Ctrl
            int norm = IsShiftKey(vk) ? VK_SHIFT : IsCtrlKey(vk) ? VK_CONTROL : 0;
            if (norm != 0)
            {
                if (tapVk != norm || !tapClean) { tapVk = norm; tapClean = true; tapDownTime = Environment.TickCount; }
            }
            else { tapClean = false; lastTapVk = 0; }

            bool shift = Native.IsDown(VK_SHIFT), ctrl = Native.IsDown(VK_CONTROL), alt = Native.IsDown(VK_MENU);
            bool win = Native.IsDown(VK_LWIN) || Native.IsDown(VK_RWIN);

            if (!ctrl && !alt && !win)
            {
                if (Cfg.WordKey.Vk == vk && Cfg.WordKey.Shift == shift) { ManualConvert(); return true; }
                if (Cfg.SelectionKey.Vk == vk && Cfg.SelectionKey.Shift == shift) { ConvertSelection(); return true; }
            }

            if (IsModifier(vk)) return false;
            lastConv = null;

            if (ctrl || alt || win) { ResetAll(); return false; }

            if (Layouts.IsMapped(vk))
            {
                bool caps = (Native.GetKeyState(VK_CAPITAL) & 1) != 0;
                buffer.Add(new Stroke(vk, shift, caps));
                if (buffer.Count > 64) ResetAll();
                return false;
            }
            if (vk == VK_BACK)
            {
                if (buffer.Count > 0) buffer.RemoveAt(buffer.Count - 1);
                else lastWord = null;
                return false;
            }
            if (IsTrigger(vk)) return OnTrigger(vk, fg);

            ResetAll();
            return false;
        }

        void OnKeyUp(int vk)
        {
            int norm = IsShiftKey(vk) ? VK_SHIFT : IsCtrlKey(vk) ? VK_CONTROL : 0;
            if (norm == 0 || !tapClean || tapVk != norm) return;
            int now = Environment.TickCount;
            tapClean = false;
            if (now - tapDownTime > 350) { lastTapVk = 0; return; }
            if (lastTapVk == norm && now - lastTapTime < 450)
            {
                lastTapVk = 0;
                if (!Cfg.Enabled || fgExcluded) return;
                if (Cfg.WordKey.DoubleTap == norm) ManualConvert();
                else if (Cfg.SelectionKey.DoubleTap == norm) ConvertSelection();
                return;
            }
            lastTapVk = norm; lastTapTime = now;
        }

        bool OnTrigger(int vk, IntPtr fg)
        {
            lastConv = null;
            if (buffer.Count == 0) { lastWord = null; return false; }
            var strokes = new List<Stroke>(buffer);
            buffer.Clear();
            int lang = LangOf(fg);
            if (lang < 0) { lastWord = null; return false; }

            if (Cfg.AutoSwitch)
            {
                var d = Det.Analyze(strokes, lang);
                if (d.Convert)
                {
                    List<Stroke> prev = null;
                    if (Cfg.Retro && lastWord != null && lastWordLang == lang && lastWordTrigger == VK_SPACE && Det.ShouldConvertPrev(lastWord, lang))
                        prev = lastWord;
                    lastWord = null;

                    var c = new Conv
                    {
                        Original = Layouts.Text(strokes, lang),
                        Converted = Layouts.Text(strokes, 1 - lang),
                        Trigger = vk, From = lang, To = 1 - lang, Kind = "auto", Word = d.Cur
                    };
                    int erase = strokes.Count;
                    if (prev != null)
                    {
                        c.Original = Layouts.Text(prev, lang) + " " + c.Original;
                        c.Converted = Layouts.Text(prev, 1 - lang) + " " + c.Converted;
                        erase += prev.Count + 1;
                    }
                    Schedule(c, erase);
                    return true; // hold space/Enter for now, type it after the word
                }
            }

            lastWord = (vk == VK_SPACE || vk == VK_TAB) ? strokes : null;
            lastWordLang = lang; lastWordTrigger = vk;
            return false;
        }

        // ───────────────────────── conversions ─────────────────────────

        void Schedule(Conv c, int erase)
        {
            busy = true;
            Ctl.BeginInvoke(new Action(() => Apply(c, erase)));
        }

        void Apply(Conv c, int erase)
        {
            try
            {
                var list = new List<Native.INPUT>();
                for (int i = 0; i < erase; i++) { list.Add(Native.Key(VK_BACK, false, TAG)); list.Add(Native.Key(VK_BACK, true, TAG)); }
                foreach (char ch in c.Converted) { list.Add(Native.Unicode(ch, false, TAG)); list.Add(Native.Unicode(ch, true, TAG)); }
                if (c.Trigger != 0) { list.Add(Native.Key(c.Trigger, false, TAG)); list.Add(Native.Key(c.Trigger, true, TAG)); }
                SwitchLayout(c.To);
                Native.Send(list);
                lastConv = c.Trigger == VK_RETURN ? null : c;
                lastWord = null;
                buffer.Clear();
                if (Cfg.Sound) { try { click.Play(); } catch { } }
                Emit(new Dictionary<string, object> {
                    { "type", "converted" }, { "kind", c.Kind }, { "from", c.Original }, { "to", c.Converted },
                    { "word", c.Word }, { "app", fgProcess }, { "toLang", Layouts.LangName(c.To) } });
            }
            catch (Exception ex) { EmitError(ex); }
            finally
            {
                busy = false;
                if (pending.Count > 0) { var p = pending; pending = new List<Native.INPUT>(); Native.Send(p); }
            }
        }

        /// <summary>Hotkey: fix the word being typed, undo the last correction, or fix the last word.</summary>
        void ManualConvert()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (buffer.Count > 0)
            {
                int lang = LangOf(fg);
                if (lang < 0) return;
                var strokes = new List<Stroke>(buffer);
                buffer.Clear(); lastWord = null;
                Schedule(new Conv
                {
                    Original = Layouts.Text(strokes, lang), Converted = Layouts.Text(strokes, 1 - lang),
                    Trigger = 0, From = lang, To = 1 - lang, Kind = "manual"
                }, strokes.Count);
            }
            else if (lastConv != null)
            {
                var p = lastConv;
                lastConv = null;
                Schedule(new Conv
                {
                    Original = p.Converted, Converted = p.Original, Trigger = p.Trigger, From = p.To, To = p.From,
                    Kind = "undo", Word = p.Kind == "auto" ? p.Word : null
                }, p.Converted.Length + (p.Trigger != 0 ? 1 : 0));
            }
            else if (lastWord != null)
            {
                var w = lastWord; int l = lastWordLang;
                lastWord = null;
                Schedule(new Conv
                {
                    Original = Layouts.Text(w, l), Converted = Layouts.Text(w, 1 - l),
                    Trigger = lastWordTrigger, From = l, To = 1 - l, Kind = "manual"
                }, w.Count + 1);
            }
        }

        /// <summary>Re-encode the selected text through the clipboard.</summary>
        void ConvertSelection()
        {
            ResetAll();
            string saved = null;
            try { if (Clipboard.ContainsText()) saved = Clipboard.GetText(); } catch { }
            try { Clipboard.Clear(); } catch { }

            var list = new List<Native.INPUT>();
            ReleaseModifiers(list);
            list.Add(Native.Key(VK_CONTROL, false, TAG)); list.Add(Native.Key(VK_C, false, TAG));
            list.Add(Native.Key(VK_C, true, TAG)); list.Add(Native.Key(VK_CONTROL, true, TAG));
            Native.Send(list);

            int attempts = 0;
            var t = new Timer { Interval = 40 };
            t.Tick += delegate
            {
                attempts++;
                string text = null;
                try { if (Clipboard.ContainsText()) text = Clipboard.GetText(); } catch { }
                if (string.IsNullOrEmpty(text) && attempts < 15) return;
                t.Stop(); t.Dispose();
                if (string.IsNullOrEmpty(text)) { RestoreClipboard(saved); return; }

                int from = Layouts.DetectTextLang(text), to = 1 - from;
                string conv = Layouts.ConvertText(text, from, to);
                try { Clipboard.SetText(conv); } catch { RestoreClipboard(saved); return; }
                var paste = new List<Native.INPUT>();
                paste.Add(Native.Key(VK_CONTROL, false, TAG)); paste.Add(Native.Key(VK_V, false, TAG));
                paste.Add(Native.Key(VK_V, true, TAG)); paste.Add(Native.Key(VK_CONTROL, true, TAG));
                SwitchLayout(to);
                Native.Send(paste);
                if (Cfg.Sound) { try { click.Play(); } catch { } }
                Emit(new Dictionary<string, object> {
                    { "type", "converted" }, { "kind", "selection" }, { "from", text }, { "to", conv },
                    { "app", fgProcess }, { "toLang", Layouts.LangName(to) } });
                Delay(500, () => RestoreClipboard(saved));
            };
            t.Start();
        }

        static void ReleaseModifiers(List<Native.INPUT> list)
        {
            foreach (int vk in new[] { VK_LSHIFT, VK_RSHIFT, VK_LCONTROL, VK_RCONTROL, VK_LMENU, VK_RMENU })
                if (Native.IsDown(vk)) list.Add(Native.Key(vk, true, TAG));
        }

        static void RestoreClipboard(string saved)
        {
            try { if (saved != null) Clipboard.SetText(saved); else Clipboard.Clear(); } catch { }
        }

        static void Delay(int ms, Action a)
        {
            var t = new Timer { Interval = ms };
            t.Tick += delegate { t.Stop(); t.Dispose(); a(); };
            t.Start();
        }

        // ───────────────────────── layout and windows ─────────────────────────

        public static int LangOf(IntPtr hwnd)
        {
            uint pid;
            uint tid = Native.GetWindowThreadProcessId(hwnd, out pid);
            return Layouts.LangFromHkl(Native.GetKeyboardLayout(tid));
        }

        public static void SwitchLayout(int lang)
        {
            IntPtr hkl = Layouts.FindHkl(lang);
            if (hkl == IntPtr.Zero) return;
            IntPtr fg = Native.GetForegroundWindow();
            Native.PostMessage(fg, Native.WM_INPUTLANGCHANGEREQUEST, IntPtr.Zero, hkl);
        }

        void ReportLayout()
        {
            int lang = LangOf(Native.GetForegroundWindow());
            if (lang == reportedLang) return;
            reportedLang = lang;
            Emit(new Dictionary<string, object> { { "type", "layout" }, { "lang", Layouts.LangName(lang) } });
        }

        public void ForceReportLayout() { reportedLang = -2; ReportLayout(); }

        string ProcessNameOf(IntPtr hwnd)
        {
            uint pid;
            Native.GetWindowThreadProcessId(hwnd, out pid);
            string name;
            if (procCache.TryGetValue(pid, out name)) return name;
            try { name = Process.GetProcessById((int)pid).ProcessName; } catch { name = ""; }
            if (procCache.Count > 500) procCache.Clear();
            procCache[pid] = name;
            return name;
        }

        public List<string> ListApps()
        {
            var set = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            Native.EnumWindows((h, l) =>
            {
                if (Native.IsWindowVisible(h) && Native.GetWindowTextLength(h) > 0 && Native.GetWindow(h, 4 /*GW_OWNER*/) == IntPtr.Zero)
                {
                    string n = ProcessNameOf(h);
                    if (n.Length > 0) set.Add(n);
                }
                return true;
            }, IntPtr.Zero);
            return new List<string>(set);
        }

        void EmitError(Exception ex)
        {
            Emit(new Dictionary<string, object> { { "type", "error" }, { "message", ex.Message } });
        }
    }

    static class Sound
    {
        /// <summary>A short soft click in WAV format.</summary>
        public static Stream MakeClick()
        {
            const int rate = 22050;
            int n = rate * 35 / 1000;
            var ms = new MemoryStream();
            var w = new BinaryWriter(ms);
            w.Write(new[] { 'R', 'I', 'F', 'F' }); w.Write(36 + n * 2);
            w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(rate); w.Write(rate * 2); w.Write((short)2); w.Write((short)16);
            w.Write(new[] { 'd', 'a', 't', 'a' }); w.Write(n * 2);
            for (int i = 0; i < n; i++)
            {
                double t = (double)i / rate;
                double v = (Math.Sin(2 * Math.PI * 1500 * t) * 0.6 + Math.Sin(2 * Math.PI * 2300 * t) * 0.4) * Math.Exp(-t * 140) * 0.35;
                w.Write((short)(v * 32767));
            }
            w.Flush();
            ms.Position = 0;
            return ms;
        }
    }
}
