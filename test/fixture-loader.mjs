// 测试辅助：加载 fixtures 原始表（解析逻辑复用 tools/check-materials.mjs）
import { readFile } from 'node:fs/promises';
import { parseTable } from '../tools/check-materials.mjs';

const folder = new URL('../fixtures/', import.meta.url);

const format = JSON.parse(await readFile(new URL('format.json', folder), 'utf8'));
const tables = {};
for (const [name, fields] of Object.entries(format.tables)) {
  const content = await readFile(new URL(`${name}.csv`, folder), 'utf8');
  tables[name] = parseTable(content, fields, name);
}

export default tables;
