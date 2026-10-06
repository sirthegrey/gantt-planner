// Build the standalone single-file app: dist/Gantt.html
// Every dependency (SheetJS + app sources) is inlined; the result runs from
// file:// with no network access.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const APP_SOURCES = [
  'src/holidays.js',
  'src/calendar.js',
  'src/dates.js',
  'src/stacks.js',
  'src/parse.js',
  'src/schedule.js',
  'src/render.js',
  'src/app.js'
];

const CONVERTER_SOURCES = [
  'src/dates.js',
  'src/stacks.js',
  'src/converter.js',
  'src/converter-ui.js'
];

function escapeScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

const styles = readFileSync(join(root, 'src/styles.css'), 'utf8');
const sheetjs = readFileSync(join(root, 'vendor/xlsx.full.min.js'), 'utf8');

function bundle(sources, sourceUrlName) {
  const parts = sources.map((p) => {
    const code = readFileSync(join(root, p), 'utf8');
    return `\n// ==== ${p} ====\n${code}`;
  });
  return parts.join('\n') + `\n//# sourceURL=${sourceUrlName}\n`;
}

function buildPage(templatePath, sources, sourceUrlName, outName) {
  let html = readFileSync(join(root, templatePath), 'utf8');
  html = html.replace('/*{{STYLES}}*/', () => styles);
  html = html.replace('/*{{SHEETJS}}*/', () => escapeScript(sheetjs));
  html = html.replace('/*{{APP}}*/', () => escapeScript(bundle(sources, sourceUrlName)));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const out = join(root, 'dist', outName);
  writeFileSync(out, html, 'utf8');
  console.log(`built ${out} (${(html.length / 1024).toFixed(0)} KB)`);
}

buildPage('src/index.html', APP_SOURCES, 'gantt-app.js', 'Gantt.html');
buildPage('src/converter.html', CONVERTER_SOURCES, 'gantt-converter.js', 'Конвертер.html');
