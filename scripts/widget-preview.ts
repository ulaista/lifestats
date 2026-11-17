// Writes data/preview/widget.html: the real widget HTML plus a fake window.TelegramWidget that answers
// requests from precomputed payloads — to check the look in a normal browser.
// Usage: DATA_DIR=data/test node scripts/widget-preview.ts [dark|light]
import fs from 'node:fs';
import path from 'node:path';
import { WIDGET_HTML, widgetPayload } from '../server/bot/widget.ts';
import { SECTIONS, KINDS } from '../server/stats/views.ts';

const dark = (process.argv[2] ?? 'dark') === 'dark';
const theme = dark
  ? { bg_color: '#212121', text_color: '#ffffff', hint_color: '#aaaaaa', button_color: '#8774e1', button_text_color: '#ffffff', secondary_bg_color: '#2c2c2e' }
  : { bg_color: '#ffffff', text_color: '#000000', hint_color: '#999999', button_color: '#3390ec', button_text_color: '#ffffff', secondary_bg_color: '#f1f1f4' };
const data: Record<string, string> = {};
for (const [s] of SECTIONS) for (const [k] of KINDS) for (const o of [0, 1, 2]) data[`${s}|${k}|${o}`] = widgetPayload(s, k, o);
const fake = `<script>
var DATA=${JSON.stringify(data)};
window.TelegramWidget={themeParams:${JSON.stringify(theme)},colorScheme:'${dark ? 'dark' : 'light'}',chatData:DATA['home|day|0'],
request:function(v){return new Promise(function(ok,no){setTimeout(function(){DATA[v]?ok({result:DATA[v]}):no({code:'FAILED'})},150)})},
onEvent:function(){},ready:function(){},HapticFeedback:{selectionChanged:function(){}}};
</script>`;
const css = Object.entries(theme).map(([k, v]) => `--tg-theme-${k.replace(/_/g, '-')}:${v}`).join(';');
const html = WIDGET_HTML.replace('<head>', `<head>${fake}<style>:root{${css}}body{background:${theme.bg_color};width:360px;border:1px solid #444;border-radius:16px}</style>`);
const out = path.resolve('data/preview');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'widget.html'), html);
console.log(path.join(out, 'widget.html'));
