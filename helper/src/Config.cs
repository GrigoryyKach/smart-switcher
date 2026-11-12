using System;
using System.Collections;
using System.Collections.Generic;

namespace SmartSwitcher
{
    /// <summary>Hotkey description: a regular key (with or without Shift) or a double tap of a modifier.</summary>
    public class HotKey
    {
        public int Vk;          // 0 = not set
        public bool Shift;
        public int DoubleTap;   // 0x10 (Shift) or 0x11 (Ctrl) for a double tap

        public static HotKey Parse(string s)
        {
            var h = new HotKey();
            if (string.IsNullOrEmpty(s) || s == "None") return h;
            if (s == "DoubleShift") { h.DoubleTap = 0x10; return h; }
            if (s == "DoubleCtrl") { h.DoubleTap = 0x11; return h; }
            if (s.StartsWith("Shift+")) { h.Shift = true; s = s.Substring(6); }
            switch (s)
            {
                case "Pause": h.Vk = 0x13; break;
                case "ScrollLock": h.Vk = 0x91; break;
                case "Insert": h.Vk = 0x2D; break;
                default:
                    int f;
                    if (s.StartsWith("F") && int.TryParse(s.Substring(1), out f) && f >= 1 && f <= 24) h.Vk = 0x70 + f - 1;
                    break;
            }
            return h;
        }
    }

    public class Config
    {
        public bool Enabled = true, AutoSwitch = true, Sound = true, Retro = true;
        public bool TriggerSpace = true, TriggerEnter = true, TriggerTab = false;
        public int Sensitivity = 6, MinWordLength = 1;
        public HotKey WordKey = HotKey.Parse("Pause");
        public HotKey SelectionKey = HotKey.Parse("Shift+Pause");
        public HashSet<string> ExcludedApps = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Exceptions = new HashSet<string>();

        public void Apply(Dictionary<string, object> d)
        {
            Bool(d, "enabled", ref Enabled);
            Bool(d, "autoSwitch", ref AutoSwitch);
            Bool(d, "sound", ref Sound);
            Bool(d, "retro", ref Retro);
            Bool(d, "triggerSpace", ref TriggerSpace);
            Bool(d, "triggerEnter", ref TriggerEnter);
            Bool(d, "triggerTab", ref TriggerTab);
            Int(d, "sensitivity", ref Sensitivity);
            Int(d, "minWordLength", ref MinWordLength);
            object o;
            if (d.TryGetValue("hotkey", out o)) WordKey = HotKey.Parse(o as string);
            if (d.TryGetValue("selectionHotkey", out o)) SelectionKey = HotKey.Parse(o as string);
            if (d.TryGetValue("excludedApps", out o))
            {
                ExcludedApps.Clear();
                foreach (var s in Strings(o))
                {
                    string n = s.Trim();
                    if (n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) n = n.Substring(0, n.Length - 4);
                    if (n.Length > 0) ExcludedApps.Add(n);
                }
            }
            if (d.TryGetValue("exceptions", out o))
            {
                Exceptions.Clear();
                foreach (var s in Strings(o)) { string n = Detector.Normalize(s.Trim()); if (n.Length > 0) Exceptions.Add(n); }
            }
        }

        static void Bool(Dictionary<string, object> d, string k, ref bool v) { object o; if (d.TryGetValue(k, out o) && o is bool) v = (bool)o; }
        static void Int(Dictionary<string, object> d, string k, ref int v)
        {
            object o; if (!d.TryGetValue(k, out o) || o == null) return;
            try { v = Convert.ToInt32(o); } catch { }
        }
        static IEnumerable<string> Strings(object o)
        {
            var e = o as IEnumerable;
            if (e == null || o is string) yield break;
            foreach (var x in e) if (x is string) yield return (string)x;
        }
    }
}
