using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;

namespace SmartSwitcher
{
    /// <summary>Символьная триграммная модель языка.</summary>
    public class NGramModel
    {
        readonly Dictionary<string, int> tri = new Dictionary<string, int>();
        readonly Dictionary<string, int> triCtx = new Dictionary<string, int>();
        readonly Dictionary<string, int> bi = new Dictionary<string, int>();
        readonly Dictionary<char, int> biCtx = new Dictionary<char, int>();
        readonly Dictionary<char, int> uni = new Dictionary<char, int>();
        int total;

        static void Inc<T>(Dictionary<T, int> d, T k) { int v; d.TryGetValue(k, out v); d[k] = v + 1; }

        public void Add(string w)
        {
            if (w.Length == 0) return;
            string s = "^^" + w + "$";
            for (int i = 2; i < s.Length; i++)
            {
                Inc(tri, s.Substring(i - 2, 3));
                Inc(triCtx, s.Substring(i - 2, 2));
                Inc(bi, s.Substring(i - 1, 2));
                Inc(biCtx, s[i - 1]);
                Inc(uni, s[i]);
                total++;
            }
        }

        /// <summary>Средний логарифм вероятности символа (чем ближе к 0, тем «естественнее» слово).</summary>
        public double Score(string w)
        {
            if (w.Length == 0) return -99;
            string s = "^^" + w + "$";
            double sum = 0; int n = 0;
            for (int i = 2; i < s.Length; i++)
            {
                int ctx, x;
                double p3 = 0, p2 = 0;
                if (triCtx.TryGetValue(s.Substring(i - 2, 2), out ctx) && ctx > 0)
                { tri.TryGetValue(s.Substring(i - 2, 3), out x); p3 = (double)x / ctx; }
                if (biCtx.TryGetValue(s[i - 1], out ctx) && ctx > 0)
                { bi.TryGetValue(s.Substring(i - 1, 2), out x); p2 = (double)x / ctx; }
                int u; uni.TryGetValue(s[i], out u);
                double p1 = (u + 0.1) / (total + 4.0);
                double p = 0.55 * p3 + 0.30 * p2 + 0.15 * p1;
                sum += Math.Log(p); n++;
            }
            return sum / n;
        }
    }

    public class Decision
    {
        public string Cur = "", Alt = "";
        public bool CurValid, AltValid, CurInDict, AltInDict, IsException;
        public double CurScore = -99, AltScore = -99;
        public bool Convert;
        public string Reason = "";
    }

    public class Detector
    {
        public readonly HashSet<string>[] Dict = { new HashSet<string>(), new HashSet<string>() };
        readonly NGramModel[] models = { new NGramModel(), new NGramModel() };
        public HashSet<string> Exceptions = new HashSet<string>();

        public double Threshold = 0.67;  // насколько альтернатива должна быть «лучше» (в нормированных баллах)
        public double Floor = 0.35;      // минимально правдоподобный балл для альтернативы
        public double GoodLevel = 0.9;   // выше этого слово считается вполне «нормальным»
        public int MinLength = 1;
        public int NgramMinLength = 3;
        public bool UseDict = true;

        static readonly string[] singles = { "a i", "а в и к о с у я ж" };

        // Калибровка: средний балл «настоящего» слова и «абракадабры» (слова другого языка в чужой раскладке).
        readonly double[] realMean = new double[2], junkMean = new double[2];

        public static Detector LoadEmbedded()
        {
            var d = new Detector();
            d.Load(Layouts.EN, ReadResource("en.txt"));
            d.Load(Layouts.RU, ReadResource("ru.txt"));
            d.Calibrate();
            return d;
        }

        /// <summary>
        /// Оцениваем шкалу каждой модели на отложенной выборке: учим временную модель на половине слов,
        /// меряем средний балл на другой половине (настоящие слова) и на словах другого языка (мусор).
        /// </summary>
        public void Calibrate()
        {
            for (int L = 0; L < 2; L++)
            {
                var words = new List<string>(Dict[L]);
                var tmp = new NGramModel();
                for (int i = 0; i < words.Count; i += 2) tmp.Add(Strip(words[i]));
                double sum = 0; int n = 0;
                for (int i = 1; i < words.Count; i += 2) if (words[i].Length >= 3) { sum += tmp.Score(Strip(words[i])); n++; }
                realMean[L] = n > 0 ? sum / n : -2.5;

                sum = 0; n = 0;
                foreach (var w in Dict[1 - L])
                {
                    if (w.Length < 3) continue;
                    var s = Layouts.StrokesFor(w, 1 - L);
                    if (s == null) continue;
                    bool valid; string junk = Clean(Layouts.Text(s, L), L, out valid);
                    if (!valid) continue;
                    sum += tmp.Score(Strip(junk)); n++;
                }
                junkMean[L] = n > 0 ? sum / n : -4.5;
            }
        }

        /// <summary>Нормированный балл: 0 — типичная абракадабра, 1 — типичное слово языка.</summary>
        public double Norm(int lang, double raw)
        {
            if (raw <= -98) return -9;
            double span = realMean[lang] - junkMean[lang];
            if (span < 0.3) span = 0.3;
            return (raw - junkMean[lang]) / span;
        }

        public string CalibrationInfo()
        {
            return string.Format("EN real={0:F2} junk={1:F2}; RU real={2:F2} junk={3:F2}", realMean[0], junkMean[0], realMean[1], junkMean[1]);
        }

        static string ReadResource(string name)
        {
            using (var s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
            {
                if (s == null) return "";
                using (var r = new StreamReader(s, Encoding.UTF8)) return r.ReadToEnd();
            }
        }

        public void Load(int lang, string text)
        {
            foreach (var single in singles[lang].Split(' ')) Dict[lang].Add(single);
            foreach (var tok in text.Split(new[] { ' ', '\n', '\r', '\t' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (tok.StartsWith("#")) continue;
                string w = Normalize(tok);
                if (w.Length < 2) continue;
                if (Dict[lang].Add(w)) models[lang].Add(Strip(w));
            }
        }

        /// <summary>Чувствительность 1..10 → порог.</summary>
        public void SetSensitivity(int s)
        {
            if (s < 1) s = 1; if (s > 10) s = 10;
            // баллы нормированы: 0 — абракадабра, 1 — обычное слово
            Threshold = 0.85 - 0.065 * (s - 1); // 1 → 0.85 (осторожно), 5 → 0.59, 10 → 0.27 (агрессивно)
            Floor = 0.48 - 0.045 * (s - 1);     // 1 → 0.48, 5 → 0.30, 10 → 0.075
        }

        public static string Normalize(string s) { return s.ToLowerInvariant().Replace('ё', 'е'); }
        static string Strip(string w) { return w.Replace("-", "").Replace("'", ""); }

        /// <summary>Отрезать знаки препинания по краям и проверить, что середина — буквы нужного алфавита.</summary>
        public static string Clean(string raw, int lang, out bool valid)
        {
            int st = 0, en = raw.Length;
            while (st < en && !char.IsLetter(raw[st])) st++;
            while (en > st && !char.IsLetter(raw[en - 1])) en--;
            string core = raw.Substring(st, en - st);
            valid = core.Length > 0;
            foreach (char ch in core)
            {
                if (lang == Layouts.EN ? Layouts.IsLatin(ch) : Layouts.IsCyrillic(ch)) continue;
                if (ch == '-') continue;
                if (ch == '\'' && lang == Layouts.EN) continue;
                valid = false;
            }
            return Normalize(core);
        }

        static int CountLetters(string s) { int n = 0; foreach (char c in s) if (char.IsLetter(c)) n++; return n; }

        bool InDict(int lang, string w) { return UseDict && Dict[lang].Contains(w); }

        public double ScoreWord(int lang, string w) { return models[lang].Score(Strip(w)); }

        public Decision Analyze(IList<Stroke> strokes, int cur)
        {
            int alt = 1 - cur;
            var d = new Decision();
            d.Cur = Clean(Layouts.Text(strokes, cur), cur, out d.CurValid);
            d.Alt = Clean(Layouts.Text(strokes, alt), alt, out d.AltValid);
            d.CurInDict = d.CurValid && InDict(cur, d.Cur);
            d.AltInDict = d.AltValid && InDict(alt, d.Alt);
            d.IsException = Exceptions.Contains(d.Cur);
            if (d.CurValid) d.CurScore = Norm(cur, ScoreWord(cur, d.Cur));
            if (d.AltValid) d.AltScore = Norm(alt, ScoreWord(alt, d.Alt));
            int letters = CountLetters(d.Alt);

            if (!d.AltValid) { d.Reason = "в другой раскладке получается не слово"; return d; }
            if (d.IsException) { d.Reason = "слово в списке исключений"; return d; }
            if (letters < MinLength) { d.Reason = "слово короче минимальной длины"; return d; }
            if (d.CurInDict) { d.Reason = "слово есть в словаре текущей раскладки"; return d; }
            if (d.AltInDict)
            {
                if (letters >= 5 && d.CurValid && d.CurScore > GoodLevel && d.AltScore < d.CurScore)
                { d.Reason = "слово выглядит естественно в обеих раскладках"; return d; }
                d.Convert = true; d.Reason = "слово найдено в словаре другой раскладки"; return d;
            }
            if (letters < NgramMinLength) { d.Reason = "слишком короткое слово, а в словаре его нет"; return d; }
            if (!d.CurValid)
            {
                // знаки препинания посреди «слова» — сильный сигнал, планку для альтернативы снижаем
                d.Convert = d.AltScore > Floor - 0.5;
                d.Reason = d.Convert ? "в текущей раскладке получается бессмыслица из знаков" : "ни одна раскладка не даёт похожего слова";
                return d;
            }
            double diff = d.AltScore - d.CurScore;
            d.Convert = diff > Threshold && d.AltScore > Floor;
            d.Reason = d.Convert ? "буквосочетания намного типичнее для другого языка"
                     : d.AltScore <= Floor ? "в другой раскладке слово тоже не похоже на настоящее"
                     : "разница недостаточна для уверенного переключения";
            return d;
        }

        /// <summary>Нужно ли исправить предыдущее короткое слово вместе с текущим (только надёжные случаи).</summary>
        public bool ShouldConvertPrev(IList<Stroke> strokes, int cur)
        {
            var d = Analyze(strokes, cur);
            return d.AltValid && d.AltInDict && !d.CurInDict && !d.IsException;
        }
    }
}
