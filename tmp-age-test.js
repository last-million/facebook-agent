// throwaway unit test for fbTimestampToAgeDays
function fbTimestampToAgeDays(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return { days: null, confident: false };
  if (/(just now|a few seconds|moment ago|^now$|^just\b|ahora|hace un momento|à l'instant|a l'instant|à linstant|الآن|للتو)/i.test(s)) return { days: 0, confident: true };
  const m = s.match(/(\d+)\s*([a-zàâäéèêëîïôöùûüçñ؀-ۿ]+)/i);
  if (m) {
    const n = Number(m[1]); const u = m[2];
    if (/^(s|sec|secs|second|seconds|min|mins|minute|minutes|mn|m|h|hr|hrs|hour|hours|heure|heures|hora|horas|دقيقة|دقائق|ساعة|ساعات)$/.test(u)) return { days: 0, confident: true };
    if (/^(d|day|days|j|jour|jours|d[ií]a|d[ií]as|dia|dias|يوم|أيام|ايام)$/.test(u)) return { days: n, confident: true };
    if (/^(w|wk|wks|week|weeks|sem|semaine|semaines|semana|semanas|أسبوع|اسبوع|أسابيع|اسابيع)$/.test(u)) return { days: n * 7, confident: true };
    if (/^(mo|mos|month|months|mois|mes|meses|شهر|أشهر|شهور)$/.test(u)) return { days: n * 30, confident: true };
    if (/^(y|yr|yrs|year|years|an|ans|ann[ée]e|ann[ée]es|a[ñn]o|a[ñn]os|سنة|سنوات|عام|أعوام)$/.test(u)) return { days: n * 365, confident: true };
  }
  if (/\b(19|20)\d{2}\b/.test(s)) return { days: 400, confident: true };
  const MONTH = '(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|ene(ro)?|abr(il)?|ago(sto)?|dic(iembre)?|janv(ier)?|f[ée]vr(ier)?|mars|avr(il)?|mai|juin|juil(let)?|ao[ûu]t|d[ée]c(embre)?)';
  if (new RegExp('(\\b\\d{1,2}\\s*' + MONTH + '\\b|\\b' + MONTH + '\\s+\\d{1,2}\\b)', 'i').test(s)) return { days: 30, confident: true };
  return { days: null, confident: false };
}
const MAX = 2;
// [string, expected decision]  KEEP = harvest, STOP = too old, OPEN = unknown(fail-open=harvest)
const cases = [
  ['Just now','KEEP'],['5m','KEEP'],['5 min','KEEP'],['23h','KEEP'],['1 hour ago','KEEP'],
  ['1d','KEEP'],['2d','KEEP'],['2 days ago','KEEP'],['3d','STOP'],['6d','STOP'],
  ['1w','STOP'],['2 weeks ago','STOP'],['June 15','STOP'],['June 15, 2025','STOP'],['15 Mar','STOP'],
  ['2 j','KEEP'],['3 jours','STOP'],['il y a 3 jours','STOP'],['hace 2 días','KEEP'],['hace 5 días','STOP'],
  ['5h ago','KEEP'],['3d ago','STOP'],['15 ago 2024','STOP'],
  ['Yesterday','OPEN'],['Marshalls deal','OPEN'],['Shop now','OPEN'],['',  'OPEN'],
  ['الآن','KEEP'],['منذ ساعة','OPEN'],
];
let pass=0, fail=0;
for (const [s, exp] of cases) {
  const a = fbTimestampToAgeDays(s);
  let dec;
  if (!a.confident) dec='OPEN';
  else if (a.days > MAX) dec='STOP';
  else dec='KEEP';
  const ok = dec===exp;
  if(ok)pass++;else fail++;
  console.log(`${ok?'ok  ':'FAIL'}  "${s}" -> days=${a.days} conf=${a.confident} => ${dec} (exp ${exp})`);
}
console.log(`\n${pass} pass, ${fail} fail`);
