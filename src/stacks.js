'use strict';

/* Стеки: общие определения для Ганта и конвертера.
 *
 * В файлах стек называют по-разному (TS / Front / front, C# / .Net / net),
 * поэтому все написания сводятся к четырём ключам: cpp, py, net, front.
 */

const STACKS = [
  { key: 'cpp', label: 'C++', hoursCol: 9, execCol: 10, series: 1 },
  { key: 'py', label: 'Питон', hoursCol: 11, execCol: 12, series: 2 },
  { key: 'net', label: 'Дотнет', hoursCol: 13, execCol: 14, series: 3 },
  { key: 'front', label: 'Фронт', hoursCol: 15, execCol: 16, series: 4 }
];

/** Порядок стеков по умолчанию - как идут блоки в шаблоне. */
const STACK_ORDER = ['cpp', 'py', 'net', 'front'];

/** Короткие описания для конвертера. */
const CONVERTER_STACKS = STACKS.map((s) => ({ key: s.key, label: s.label }));

/* Синонимы стеков. Ключ - нормализованное написание (нижний регистр, без
 * пробелов), значение - ключ стека. TS / Front / front - это фронт,
 * C# / .Net / net - это дотнет. */
const STACK_ALIASES = {
  'c++': 'cpp',
  'cpp': 'cpp',
  'си++': 'cpp',
  'python': 'py',
  'py': 'py',
  'питон': 'py',
  'c#': 'net',
  'c#/.net': 'net',
  '.net': 'net',
  'net': 'net',
  'dotnet': 'net',
  'дотнет': 'net',
  'ts': 'front',
  'ts/js': 'front',
  'front': 'front',
  'frontend': 'front',
  'фронт': 'front'
};

/** Написание стека -> ключ (cpp|py|net|front) или null, если стек неизвестен. */
function normalizeStackKey(label) {
  const norm = String(label === null || label === undefined ? '' : label)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  return STACK_ALIASES[norm] || null;
}

function stackByLabel(label) {
  const key = normalizeStackKey(label);
  if (!key) return null;
  return STACKS.find((s) => s.key === key) || null;
}
