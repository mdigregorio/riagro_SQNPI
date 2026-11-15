export const columns = [
  { field: 'nom_ragisoc', label: 'Denominazione' },
  { field: 'cf_pi', label: 'CF / P. IVA' },
  { field: 'anno_campagna', label: 'Campagna' },
  { field: 'scopo', label: 'Scopo' },
  { field: 'tipo_adesione', label: 'Adesione' },
  { field: 'supe_cert_ha', label: 'Superficie (ha)' },
  { field: 'fine_validita', label: 'Fine validità' },
  { field: 'olivo', label: 'Olivo' },
  { field: 'vite', label: 'Vite' },
];

const compareText = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const fieldFilters = {
  year: 'anno_campagna', scope: 'scopo', activity: 'tipo_adesione', olive: 'olivo', vine: 'vite',
};
const fileRoles = {
  aziende: /^(aziende|aziende-con-certificazione-sqnpi)\.(json|csv)$/i,
  colture: /^(colture|colture-agricole-certificate-sqnpi)\.(json|csv)$/i,
  elenco: /^(elenco|codici|cf_piva)\.csv$/i,
};

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function todayInItaly() {
  const values = Object.fromEntries(new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatDate(date) {
  return date.split('-').reverse().join('/');
}

export function discoverSnapshots(files) {
  const directories = new Map();
  const warnings = [];
  for (const file of files) {
    const path = (file.webkitRelativePath || file.path || file.name).replaceAll('\\', '/');
    const segments = path.split('/');
    const filename = segments.pop();
    const date = segments.at(-1);
    if (!date || !validDate(date)) continue;
    const directory = segments.join('/');
    const snapshot = directories.get(directory) || { date, duplicates: new Set() };
    directories.set(directory, snapshot);
    const role = Object.keys(fileRoles).find(key => fileRoles[key].test(filename));
    if (!role) continue;
    if (snapshot[role]) snapshot.duplicates.add(role);
    else snapshot[role] = file;
  }

  const snapshotsByDate = new Map();
  for (const [directory, { date, duplicates, ...filesForDate }] of directories) {
    const missing = Object.keys(fileRoles).filter(role => !filesForDate[role]);
    if (duplicates.size) warnings.push(`${directory} · più file per ${[...duplicates].join(', ')}`);
    if (missing.length) warnings.push(`${directory} · mancano ${missing.join(', ')}`);
    if (missing.length || duplicates.size) continue;
    const candidates = snapshotsByDate.get(date) || [];
    candidates.push({ date, ...filesForDate });
    snapshotsByDate.set(date, candidates);
  }

  const snapshots = [];
  for (const [date, candidates] of snapshotsByDate) {
    if (candidates.length === 1) snapshots.push(candidates[0]);
    else warnings.push(`${formatDate(date)} · più cartelle complete con la stessa data`);
  }
  snapshots.sort((a, b) => b.date.localeCompare(a.date));
  return { snapshots, warnings };
}

export function defaultSnapshot(snapshots, today = todayInItaly()) {
  return snapshots.find(snapshot => snapshot.date <= today);
}

function compareByField(field, a, b) {
  if (field === 'supe_cert_ha') {
    const aNumber = a === '' || a == null ? NaN : Number(String(a).replace(',', '.'));
    const bNumber = b === '' || b == null ? NaN : Number(String(b).replace(',', '.'));
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  }
  return compareText.compare(String(a ?? ''), String(b ?? ''));
}

export function filterCompanies(companies, filters = {}, sort = { field: 'nom_ragisoc', direction: 'asc' }) {
  const search = String(filters.search ?? '').trim().toLocaleLowerCase('it');
  const activeFilters = Object.entries(fieldFilters).filter(([key]) => filters[key] != null && filters[key] !== '');
  return companies.filter(company => {
    if (search && ![company.cf_pi, company.nom_ragisoc].some(value => String(value ?? '').toLocaleLowerCase('it').includes(search))) {
      return false;
    }
    return activeFilters.every(([key, field]) => String(company[field] ?? '') === String(filters[key]));
  }).sort((a, b) => {
    const order = compareByField(sort.field, a[sort.field], b[sort.field]);
    return (sort.direction === 'desc' ? -order : order)
      || compareText.compare(a.nom_ragisoc ?? '', b.nom_ragisoc ?? '')
      || compareText.compare(a.cf_pi ?? '', b.cf_pi ?? '')
      || compareText.compare(b.anno_campagna ?? '', a.anno_campagna ?? '')
      || compareText.compare(a.source_subject ?? '', b.source_subject ?? '');
  });
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\t\r\n]|^\s*[=+@-]/.test(text) && !/^-?\d+(?:[.,]\d+)?$/.test(text)) text = `'${text}`;
  return /[;"\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportCsv(rows, missing) {
  const header = ['cf_pi', ...columns.map(column => column.field).filter(field => field !== 'cf_pi'), 'esito'];
  const data = rows.map(row => header.map(field => field === 'esito' ? 'Presente in Aziende' : row[field]));
  const unmatched = missing.map(id => header.map(field => {
    if (field === 'cf_pi') return id;
    if (field === 'esito') return 'Non presente in Aziende';
    return '';
  }));
  return `\uFEFF${[header, ...data, ...unmatched].map(line => line.map(csvCell).join(';')).join('\r\n')}\r\n`;
}
