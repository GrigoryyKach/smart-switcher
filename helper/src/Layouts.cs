using System;
using System.Collections.Generic;
using System.Text;

namespace SmartSwitcher
{
    public struct Stroke
    {
        public int Vk; public bool Shift; public bool Caps;
        public Stroke(int vk, bool shift, bool caps) { Vk = vk; Shift = shift; Caps = caps; }
    }

    /// <summary>Таблицы соответствия клавиш для US-QWERTY и русской ЙЦУКЕН.</summary>
    public static class Layouts
    {
        public const int EN = 0, RU = 1;

        static readonly Dictionary<int, string> map = new Dictionary<int, string>();
        static readonly Dictionary<char, Stroke>[] rev = { new Dictionary<char, Stroke>(), new Dictionary<char, Stroke>() };

        static Layouts()
        {
            int[] vks = { 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', 0xDB, 0xDD,
                          'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 0xBA, 0xDE,
                          'Z', 'X', 'C', 'V', 'B', 'N', 'M', 0xBC, 0xBE, 0xBF, 0xC0, 0xBD };
            string enLo = "qwertyuiop[]asdfghjkl;'zxcvbnm,./`-";
            string enUp = "QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?~_";
            string ruLo = "йцукенгшщзхъфывапролджэячсмитьбю.ё-";
            string ruUp = "ЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,Ё_";
            for (int i = 0; i < vks.Length; i++)
            {
                map[vks[i]] = new string(new[] { enLo[i], enUp[i], ruLo[i], ruUp[i] });
                AddRev(EN, enLo[i], vks[i], false);
                AddRev(EN, enUp[i], vks[i], true);
                AddRev(RU, ruLo[i], vks[i], false);
                AddRev(RU, ruUp[i], vks[i], true);
            }
        }

        static void AddRev(int lang, char c, int vk, bool shift)
        {
            if (!rev[lang].ContainsKey(c)) rev[lang][c] = new Stroke(vk, shift, false);
        }

        public static bool IsMapped(int vk) { return map.ContainsKey(vk); }

        public static char CharFor(Stroke s, int lang)
        {
            string m = map[s.Vk];
            char lo = m[lang * 2], up = m[lang * 2 + 1];
            bool upper = s.Shift ^ (s.Caps && char.IsLetter(lo));
            return upper ? up : lo;
        }

        public static string Text(IList<Stroke> strokes, int lang)
        {
            var sb = new StringBuilder(strokes.Count);
            foreach (var s in strokes) sb.Append(CharFor(s, lang));
            return sb.ToString();
        }

        /// <summary>Перевести текст в штрихи клавиш, как если бы он набирался в раскладке lang. null — если есть неподдерживаемые символы.</summary>
        public static List<Stroke> StrokesFor(string text, int lang)
        {
            var list = new List<Stroke>();
            foreach (char c in text)
            {
                Stroke s;
                if (!rev[lang].TryGetValue(c, out s)) return null;
                list.Add(s);
            }
            return list;
        }

        public static bool IsCyrillic(char c) { return (c >= 'а' && c <= 'я') || (c >= 'А' && c <= 'Я') || c == 'ё' || c == 'Ё'; }
        public static bool IsLatin(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }

        public static int DetectTextLang(string text)
        {
            int cyr = 0, lat = 0;
            foreach (char c in text) { if (IsCyrillic(c)) cyr++; else if (IsLatin(c)) lat++; }
            return cyr > lat ? RU : EN;
        }

        /// <summary>Перекодировать текст, набранный в раскладке from, в раскладку to.</summary>
        public static string ConvertText(string text, int from, int to)
        {
            var sb = new StringBuilder(text.Length);
            foreach (char c in text)
            {
                Stroke s;
                if (rev[from].TryGetValue(c, out s)) sb.Append(CharFor(s, to));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static int LangFromHkl(IntPtr hkl)
        {
            int primary = (int)(hkl.ToInt64() & 0x3FF);
            if (primary == 0x09) return EN;
            if (primary == 0x19) return RU;
            return -1;
        }

        public static string LangName(int lang) { return lang == EN ? "en" : lang == RU ? "ru" : "other"; }

        public static IntPtr FindHkl(int lang)
        {
            int n = Native.GetKeyboardLayoutList(0, null);
            if (n <= 0) return IntPtr.Zero;
            var arr = new IntPtr[n];
            Native.GetKeyboardLayoutList(n, arr);
            foreach (var h in arr) if (LangFromHkl(h) == lang) return h;
            return IntPtr.Zero;
        }
    }
}
