// Live dashboard as a Telegram HTML widget (Bot API 10.4): the HTML lives inside the message,
// asks the bot for numbers via TelegramWidget.request() and is refreshed by the bot through
// chat_data — no hosting, the server stays on this Mac.
import { buildScreen, availableSections, periodFor, type Section } from '../stats/views.ts';
import * as Q from '../stats/queries.ts';
import { series } from '../stats/series.ts';
import { shift, type PeriodKind } from '../lib/period.ts';

/** Compact JSON (≤ 1024 bytes) describing one view of the dashboard. */
export function widgetPayload(section: Section, kind: PeriodKind, offset = 0): string {
  let anchor: string | undefined;
  let { period } = periodFor(kind);
  for (let i = 0; i < offset; i++) { anchor = shift(period, -1); period = periodFor(kind, anchor).period; }
  const sc = buildScreen(section, kind, anchor);
  const s = series(section, sc.period);
  const now = section === 'home' || section === 'music' ? Q.nowPlaying() : null;
  const sync = Q.syncTimes();
  const base = {
    v: `${section}|${kind}|${offset}`,
    t: sc.title, p: sc.period.label,
    a: availableSections(),
    e: sc.empty ?? '',
    k: sc.kpis.slice(0, 6).map((k) => [k.label.replace(/^[^\p{L}\d]+/u, ''), k.value, k.delta == null || !Number.isFinite(k.delta) ? null : Math.round(k.delta * 1000) / 10, k.goodWhenUp === undefined ? 0 : k.goodWhenUp ? 1 : -1]),
    c: { n: s.name, y: s.y, x: s.x, h: s.hi },
    np: now ? `${now.artist} — ${now.title}`.slice(0, 60) : '',
    u: sync.health ? Math.floor(Date.parse(sync.health) / 1000) : 0,
    old: sc.period.to < periodFor(kind).period.from ? 1 : 0,
  };
  // Trim until it fits Telegram's 1 KB limit for widget data.
  let json = JSON.stringify(base);
  while (Buffer.byteLength(json) > 1000 && base.c.y.length > 7) { base.c.y = base.c.y.slice(1); base.c.x = base.c.x.slice(1); if (base.c.h > 0) base.c.h--; json = JSON.stringify(base); }
  while (Buffer.byteLength(json) > 1000 && base.k.length > 2) { base.k.pop(); json = JSON.stringify(base); }
  if (Buffer.byteLength(json) > 1000) { base.np = ''; base.p = base.p.slice(0, 40); json = JSON.stringify(base); }
  return json;
}


// Kept small on purpose: the HTML must compress to ≤ 4 KB. Vanilla JS, DOM basics + Canvas 2D only.
export const WIDGET_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;padding:10px;font:13px -apple-system,system-ui,sans-serif;color:var(--tg-theme-text-color,#111);user-select:none}
.r{display:flex;gap:4px;margin-bottom:6px}.b{flex:1;min-width:0;padding:6px 0;border-radius:9px;text-align:center;background:var(--tg-theme-secondary-bg-color,#eee);font-size:13px}
.on{background:var(--tg-theme-button-color,#2a78d6);color:var(--tg-theme-button-text-color,#fff)}
.h{display:flex;align-items:baseline;justify-content:space-between;margin:8px 2px 6px}.t{font-size:17px;font-weight:700}.p,.m{color:var(--tg-theme-hint-color,#888);font-size:12px}
.k{display:grid;grid-template-columns:1fr 1fr;gap:6px}.c{background:var(--tg-theme-secondary-bg-color,#eee);border-radius:11px;padding:7px 9px}
.l{color:var(--tg-theme-hint-color,#888);font-size:11px;white-space:nowrap;overflow:hidden}.v{font-size:17px;font-weight:700;margin-top:2px;white-space:nowrap}.d{font-size:11px;margin-left:4px}
.g{color:#2fa36b}.o{color:#e8743b}canvas{width:100%;height:110px;margin-top:8px}.e{padding:18px 6px;text-align:center;color:var(--tg-theme-hint-color,#888)}
</style></head><body><div id="s" class="r"></div><div id="q" class="r"></div><div class="h"><div><div id="t" class="t"></div><div id="p" class="p"></div></div><div class="r" style="margin:0;width:84px"><div id="L" class="b">‹</div><div id="R" class="b">›</div></div></div>
<div id="k" class="k"></div><canvas id="cv"></canvas><div id="m" class="m"></div><script>
var W=window.TelegramWidget,S={home:'📊',sleep:'😴',steps:'🚶',heart:'❤️',workouts:'🏋️',music:'🎧',screen:'📱'},K=[['day','День'],['week','Нед'],['month','Мес'],['year','Год'],['all','Всё']],D=null,V='home|day|0',busy=0;
function $(i){return document.getElementById(i)}
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function go(v){if(busy)return;busy=1;$('m').textContent='…';W.request(v).then(function(a){busy=0;try{show(JSON.parse(a.result))}catch(e){$('m').textContent='ошибка данных'}},function(e){busy=0;$('m').textContent='не удалось: '+e.code})}
function show(d){D=d;V=d.v;var p=d.v.split('|'),i,s=$('s'),q=$('q'),k=$('k');s.textContent='';q.textContent='';k.textContent='';
(d.a||[]).forEach(function(x){var b=el('div','b'+(x==p[0]?' on':''),S[x]);b.onclick=function(){if(W.HapticFeedback)W.HapticFeedback.selectionChanged();go(x+'|'+p[1]+'|0')};s.appendChild(b)});
K.forEach(function(x){var b=el('div','b'+(x[0]==p[1]?' on':''),x[1]);b.onclick=function(){go(p[0]+'|'+x[0]+'|0')};q.appendChild(b)});
$('L').onclick=function(){go(p[0]+'|'+p[1]+'|'+(+p[2]+1))};$('R').onclick=function(){if(+p[2]>0)go(p[0]+'|'+p[1]+'|'+(+p[2]-1))};$('R').style.opacity=+p[2]>0?1:.35;
$('t').textContent=d.t;$('p').textContent=d.p;
if(d.e){k.appendChild(el('div','e',d.e))}
(d.k||[]).forEach(function(x){var c=el('div','c');c.appendChild(el('div','l',x[0]));var v=el('div','v',x[1]);if(x[2]!=null){var u=x[2]>0,g=x[3]==0||Math.abs(x[2])<.5?'':((u==(x[3]>0))?' g':' o');v.appendChild(el('span','d'+g,(u?'↑':x[2]<0?'↓':'→')+Math.abs(x[2])+'%'))}c.appendChild(v);k.appendChild(c)});
draw(d.c);$('m').textContent=(d.np?'▶ '+d.np+' · ':'')+(d.c&&d.c.n||'')+(d.u?' · синхр. '+ago(d.u):'')}
function ago(u){var m=Math.round(Date.now()/6e4-u/60);return m<1?'только что':m<60?m+' мин назад':m<1440?Math.round(m/60)+' ч назад':Math.round(m/1440)+' дн назад'}
function draw(c){var cv=$('cv'),w=cv.offsetWidth||300,h=110,x=cv.getContext('2d');cv.width=w*2;cv.height=h*2;x.scale(2,2);x.clearRect(0,0,w,h);if(!c||!c.y||!c.y.length)return;
var th=W.themeParams||{},mx=Math.max.apply(null,c.y)||1,n=c.y.length,bw=w/n,i;x.fillStyle=th.hint_color||'#888';x.font='10px sans-serif';
for(i=0;i<n;i++){var v=c.y[i],bh=(h-16)*v/mx;x.fillStyle=i==c.h?'#e8743b':(th.button_color||'#2a78d6');x.globalAlpha=v?1:.15;x.fillRect(i*bw+bw*.15,h-14-Math.max(bh,v?2:1),bw*.7,Math.max(bh,v?2:1))}
x.globalAlpha=1;x.fillStyle=th.hint_color||'#888';var st=Math.ceil(n/6);for(i=0;i<n;i+=st)x.fillText(c.x[i],i*bw+bw*.15,h-2);x.textAlign='right';x.fillText(String(Math.round(mx*10)/10),w-2,10)}
function fromChat(){try{var d=JSON.parse(W.chatData);if(d&&(!D||d.v==V))show(d)}catch(e){}}
W.onEvent('chatDataChanged',fromChat);W.onEvent('themeChanged',function(){if(D)show(D)});fromChat();if(!D)go(V);W.ready()
</script></body></html>`;
