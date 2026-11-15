import { columns, defaultSnapshot, discoverSnapshots, exportCsv, filterCompanies, formatDate } from './report.mjs';

const byId = id => document.getElementById(id);
const pageSize = 25;
const number = new Intl.NumberFormat('it-IT');
const folderInput = byId('folder-input');
const snapshotSelect = byId('snapshot-select');
const form = byId('search-form');
const filters = {
  search: byId('filter-text'), year: byId('filter-year'), scope: byId('filter-scope'),
  activity: byId('filter-activity'), olive: byId('filter-olive'), vine: byId('filter-vine'),
};
const phaseLabels = { elenco: 'Elenco dei codici', aziende: 'Aziende certificate', colture: 'Colture certificate' };
const sortButtons = new Map();
let snapshots = [];
let current = null;
let cached = new Map();
let worker = null;
let requestVersion = 0;
let page = 1;
let filteredRows = [];
let sort = { field: 'nom_ragisoc', direction: 'asc' };

function setStatus(message, state = 'info') {
  const status = byId('status');
  status.hidden = !message;
  status.textContent = message;
  status.dataset.state = state;
}

function setWarnings(warnings) {
  const warningBox = byId('file-warnings');
  if (!warningBox) return;
  warningBox.hidden = warnings.length === 0;
  warningBox.textContent = warnings.join(' · ');
}

function showDashboard(visible) {
  byId('dashboard').hidden = !visible;
  byId('welcome').hidden = visible;
}

function cancelWorker() {
  if (!worker) return;
  worker.instance.terminate();
  worker.reject(new Error('Importazione interrotta.'));
  worker = null;
}

function readSnapshot(snapshot) {
  const previous = cached.get(snapshot.date);
  if (previous) return Promise.resolve(previous);

  return new Promise((resolve, reject) => {
    const instance = new Worker(new URL('./import-worker.mjs', import.meta.url), { type: 'module' });
    worker = { instance, reject };
    const close = () => {
      instance.terminate();
      if (worker?.instance === instance) worker = null;
    };
    instance.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        const percent = data.total ? ` · ${Math.min(100, Math.round(data.loaded * 100 / data.total))}%` : '';
        setStatus(`Importazione ${formatDate(snapshot.date)} · ${phaseLabels[data.phase] || 'lettura dei dati'}${percent}`, 'loading');
        return;
      }
      close();
      if (data.type === 'ready') {
        cached.set(snapshot.date, data.snapshot);
        resolve(data.snapshot);
      } else {
        reject(new Error(data.message || 'Importazione non riuscita.'));
      }
    };
    instance.onerror = () => {
      close();
      reject(new Error('Il browser non è riuscito ad avviare il lettore dei file. Apri il sito tramite HTTP o HTTPS.'));
    };
    instance.postMessage(snapshot);
  });
}

function populateSnapshots(preselected) {
  snapshotSelect.replaceChildren(new Option('Scegli un aggiornamento', ''));
  for (const snapshot of snapshots) snapshotSelect.add(new Option(formatDate(snapshot.date), snapshot.date));
  snapshotSelect.disabled = snapshots.length === 0;
  snapshotSelect.value = preselected || '';
}

async function loadDates(candidates, allowFallback = false) {
  const version = ++requestVersion;
  cancelWorker();
  const errors = [];
  const original = current;
  byId('dashboard').setAttribute('aria-busy', 'true');
  byId('export-csv').disabled = true;

  for (const candidate of candidates) {
    snapshotSelect.value = candidate.date;
    setStatus(`Apertura aggiornamento del ${formatDate(candidate.date)}…`, 'loading');
    try {
      const snapshot = await readSnapshot(candidate);
      if (version !== requestVersion) return;
      displaySnapshot(snapshot);
      setStatus(errors.length ? `Aperto l’aggiornamento del ${formatDate(snapshot.date)}. ${errors.join(' ')}` : '', errors.length ? 'warning' : 'info');
      byId('dashboard').setAttribute('aria-busy', 'false');
      return;
    } catch (error) {
      if (version !== requestVersion) return;
      errors.push(`${formatDate(candidate.date)} · ${error.message}`);
      if (!allowFallback) break;
    }
  }

  byId('dashboard').setAttribute('aria-busy', 'false');
  if (original) {
    snapshotSelect.value = original.date;
    renderTable();
  } else {
    snapshotSelect.value = '';
    showDashboard(false);
  }
  setStatus(errors.join(' ') || 'Nessun aggiornamento disponibile fino a oggi. Seleziona una data dal menu.', 'error');
}

function options(select, values) {
  const initial = select.options[0]?.textContent || 'Tutti';
  select.replaceChildren(new Option(initial, ''));
  for (const value of values) select.add(new Option(value, value));
}

function uniqueField(rows, field, descending = false) {
  return [...new Set(rows.map(row => String(row[field] ?? '')).filter(Boolean))]
    .sort((a, b) => (descending ? b.localeCompare(a, 'it', { numeric: true }) : a.localeCompare(b, 'it', { numeric: true })));
}

function stat(label, value, note) {
  const box = document.createElement('article');
  box.className = 'stat-card';
  const parts = [['stat-label', label], ['stat-value', number.format(value)], ['stat-note', note]];
  for (const [className, text] of parts) {
    const line = document.createElement('div');
    line.className = className;
    line.textContent = text;
    box.append(line);
  }
  return box;
}

function displaySnapshot(snapshot) {
  current = snapshot;
  snapshotSelect.value = snapshot.date;
  byId('snapshot-date').textContent = formatDate(snapshot.date);
  const { aziende, colture } = snapshot.stats;
  const campaigns = source => source.years.length ? source.years.join(', ') : 'nessuna annata';
  const olives = new Set(snapshot.companies.filter(row => row.olivo === 1).map(row => row.cf_pi));
  const vines = new Set(snapshot.companies.filter(row => row.vite === 1).map(row => row.cf_pi));
  byId('summary').replaceChildren(
    stat('Aziende nell’export', aziende.identifiers, `${number.format(aziende.records)} record · ${campaigns(aziende)}`),
    stat('Colture nell’export', colture.records, `${number.format(colture.identifiers)} CF / P. IVA · ${campaigns(colture)}`),
    stat('Codici nell’elenco', snapshot.ids.length, `${number.format(snapshot.ids.length - snapshot.missing.length)} presenti · ${number.format(snapshot.missing.length)} assenti`),
    stat('Con olivo o vite', new Set([...olives, ...vines]).size, `Nell’elenco · ${number.format(olives.size)} olivo · ${number.format(vines.size)} vite`),
  );
  options(filters.year, uniqueField(snapshot.companies, 'anno_campagna', true));
  options(filters.scope, uniqueField(snapshot.companies, 'scopo'));
  options(filters.activity, uniqueField(snapshot.companies, 'tipo_adesione'));
  form.reset();
  sort = { field: 'nom_ragisoc', direction: 'asc' };
  page = 1;
  byId('missing-identifiers').hidden = snapshot.missing.length === 0;
  byId('missing-identifiers').open = false;
  byId('missing-count').textContent = number.format(snapshot.missing.length);
  const missingList = document.createDocumentFragment();
  for (const identifier of snapshot.missing) {
    const item = document.createElement('li');
    item.textContent = identifier;
    missingList.append(item);
  }
  byId('missing-list').replaceChildren(missingList);
  byId('folder-reopen').hidden = false;
  showDashboard(true);
  updateRows();
}

function updateRows() {
  if (!current) return;
  const values = Object.fromEntries(Object.entries(filters).map(([key, field]) => [key, field.value]));
  filteredRows = filterCompanies(current.companies, values, sort);
  renderTable();
}

function displayCell(field, value) {
  const cell = document.createElement('td');
  cell.dataset.field = field;
  if (field === 'vite' || field === 'olivo') {
    const flag = document.createElement('span');
    flag.className = 'flag';
    flag.dataset.flag = value;
    flag.textContent = value;
    flag.setAttribute('aria-label', value === 1 ? 'Presente' : value === 0 ? 'Assente tra le colture rilevate' : 'Coltura non indicata');
    cell.append(flag);
  } else {
    cell.textContent = value == null || value === '' ? '—' : value;
  }
  return cell;
}

function renderTable() {
  const pages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  page = Math.min(page, pages);
  const offset = (page - 1) * pageSize;
  const items = document.createDocumentFragment();
  for (const row of filteredRows.slice(offset, offset + pageSize)) {
    const tr = document.createElement('tr');
    for (const { field } of columns) tr.append(displayCell(field, row[field]));
    items.append(tr);
  }
  byId('table-body').replaceChildren(items);
  byId('table-empty').hidden = filteredRows.length > 0;
  byId('table-wrap').hidden = filteredRows.length === 0;
  byId('result-count').textContent = `${number.format(filteredRows.length)} record su ${number.format(current.companies.length)}`;
  byId('pagination-label').textContent = filteredRows.length ? `Pagina ${number.format(page)} di ${number.format(pages)}` : 'Nessuna pagina';
  byId('page-prev').disabled = page <= 1;
  byId('page-next').disabled = page >= pages;
  byId('export-csv').disabled = Boolean(worker) || (filteredRows.length === 0 && current.missing.length === 0);

  for (const [field, { th, arrow }] of sortButtons) {
    const selected = sort.field === field;
    if (selected) th.setAttribute('aria-sort', sort.direction === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
    arrow.textContent = selected ? (sort.direction === 'asc' ? '↑' : '↓') : '↕';
  }
}

function renderHeader() {
  const row = document.createElement('tr');
  for (const { field, label } of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.dataset.field = field;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sort-control';
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    button.append(label, arrow);
    button.addEventListener('click', () => {
      sort = { field, direction: field === sort.field && sort.direction === 'asc' ? 'desc' : 'asc' };
      page = 1;
      updateRows();
    });
    th.append(button);
    row.append(th);
    sortButtons.set(field, { th, arrow });
  }
  byId('table-head').replaceChildren(row);
}

folderInput.addEventListener('change', () => {
  const discovered = discoverSnapshots(folderInput.files);
  folderInput.value = '';
  setWarnings(discovered.warnings);
  if (discovered.snapshots.length === 0) {
    setStatus('Nessuna cartella con data valida e tutti e tre i file. Controlla nomi e struttura indicati nella guida.', 'error');
    return;
  }
  snapshots = discovered.snapshots;
  cached = new Map();
  current = null;
  showDashboard(false);
  const initial = defaultSnapshot(snapshots);
  populateSnapshots(initial?.date);
  loadDates(initial ? snapshots.slice(snapshots.indexOf(initial)) : [], true);
});

snapshotSelect.addEventListener('change', () => {
  const snapshot = snapshots.find(item => item.date === snapshotSelect.value);
  if (snapshot) loadDates([snapshot]);
  else if (current) snapshotSelect.value = current.date;
});

form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', () => { page = 1; updateRows(); });
byId('reset-filters').addEventListener('click', () => { form.reset(); page = 1; updateRows(); });
byId('page-prev').addEventListener('click', () => { page -= 1; renderTable(); });
byId('page-next').addEventListener('click', () => { page += 1; renderTable(); });
byId('export-csv').addEventListener('click', () => {
  if (!current) return;
  const file = new Blob([exportCsv(filteredRows, current.missing)], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.download = `riagro-sqnpi-${current.date}.csv`;
  link.href = objectUrl;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
});

renderHeader();
