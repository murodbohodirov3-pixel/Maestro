import { strToU8, zipSync } from 'fflate';

const COLUMNS = [
  { key: 'full_name', label: 'Имя', width: 24 },
  { key: 'phone_e164', label: 'Телефон', width: 18, style: 3 },
  { key: 'telegram_username', label: 'Telegram', width: 20 },
  { key: 'preferred_language', label: 'Язык', width: 12 },
  { key: 'lifecycle_status', label: 'Статус', width: 14 },
  { key: 'marketing_consent', label: 'Согласие на рассылку', width: 22 },
  { key: 'first_source', label: 'Первый источник', width: 18 },
  { key: 'first_contact_at', label: 'Первый контакт', width: 20, type: 'date' },
  { key: 'last_contact_at', label: 'Последний контакт', width: 20, type: 'date' },
  { key: 'first_visit_at', label: 'Первый визит', width: 20, type: 'date' },
  { key: 'last_visit_at', label: 'Последний визит', width: 20, type: 'date' },
  { key: 'visit_count', label: 'Визитов', width: 11, type: 'number' },
  { key: 'days_since_last_visit', label: 'Дней без визита', width: 17, type: 'number' },
  { key: 'eligible_for_marketing', label: 'Можно уведомлять', width: 18, type: 'boolean' },
  { key: 'id', label: 'ID клиента', width: 38 },
];

const VALUE_LABELS = {
  ru: 'Русский',
  uz: 'Узбекский',
  unknown: 'Не указано',
  lead: 'Лид',
  active: 'Активный',
  inactive: 'Неактивный',
  blocked: 'Заблокирован',
  granted: 'Разрешено',
  denied: 'Запрещено',
  admin: 'Ручная запись',
  bot: 'Бот',
  walk_in: 'С улицы',
};

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index) {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function excelSerial(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const localAsUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return (localAsUtc - Date.UTC(1899, 11, 30)) / 86400000;
}

function displayValue(key, value) {
  if (key === 'telegram_username' && value) return String(value).startsWith('@') ? value : `@${value}`;
  if (Object.prototype.hasOwnProperty.call(VALUE_LABELS, value)) return VALUE_LABELS[value];
  return value == null ? '' : value;
}

function cellXml(value, ref, style = 0, type = 'text') {
  if (value == null || value === '') return `<c r="${ref}" s="${style}"/>`;
  if (type === 'number' && Number.isFinite(Number(value))) {
    return `<c r="${ref}" s="${style}"><v>${Number(value)}</v></c>`;
  }
  if (type === 'date') {
    const serial = excelSerial(value);
    return serial == null ? `<c r="${ref}" s="2"/>` : `<c r="${ref}" s="2"><v>${serial}</v></c>`;
  }
  const rendered = type === 'boolean' ? (value ? 'Да' : 'Нет') : value;
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${escapeXml(rendered)}</t></is></c>`;
}

function sheetXml(clients) {
  const rows = [COLUMNS.map((column) => column.label), ...clients.map((client) => (
    COLUMNS.map((column) => displayValue(column.key, client[column.key]))
  ))];
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => {
      const column = COLUMNS[columnIndex];
      return cellXml(value, `${columnName(columnIndex)}${rowIndex + 1}`, rowIndex === 0 ? 1 : (column.style || 0), rowIndex === 0 ? 'text' : column.type);
    }).join('');
    return `<row r="${rowIndex + 1}"${rowIndex === 0 ? ' ht="26" customHeight="1"' : ''}>${cells}</row>`;
  }).join('');
  const lastRef = `${columnName(COLUMNS.length - 1)}${Math.max(1, rows.length)}`;
  const columnsXml = COLUMNS.map((column, index) => (
    `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columnsXml}</cols>
  <sheetData>${rowXml}</sheetData>
  <autoFilter ref="A1:${lastRef}"/>
</worksheet>`;
}

export function buildClientWorkbookBytes(clients = []) {
  const now = new Date().toISOString();
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
    'docProps/app.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Maestro Barberia</Application></Properties>`),
    'docProps/core.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Клиентская база Maestro</dc:title><dc:creator>Maestro Barberia</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created></cp:coreProperties>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Клиенты" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Aptos"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Aptos"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3A66"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml(clients)),
  };
  return zipSync(files, { level: 6 });
}

export function downloadClientWorkbook(clients = []) {
  const bytes = buildClientWorkbookBytes(clients);
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `maestro-clients-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
