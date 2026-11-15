const commonFields = ['cf_pi', 'nom_ragisoc', 'anno_campagna', 'fine_validita', 'supe_cert_ha'];
const companyFields = [...commonFields, 'scopo', 'tipo_adesione'];
const cropFields = [...commonFields, 'codi_prod', 'desc_prod'];
const knownFields = new Set([...companyFields, ...cropFields]);

const tripleColumns = [
  new Set(['s', 'sub', 'sog', 'subject', 'soggetto']),
  new Set(['p', 'pred', 'predicate', 'predicato']),
  new Set(['o', 'obj', 'ogg', 'object', 'oggetto']),
];

const idHeaders = new Set([
  'CF', 'PI', 'PIVA', 'CFPI', 'CFPIVA', 'CFPARTITAIVA', 'CUAA',
  'CODICEFISCALE', 'PARTITAIVA', 'CODICEFISCALEPARTITAIVA', 'CODICEFISCALEOPARTITAIVA',
  'CODICEFISCALEPIVA', 'PARTITAIVACODICEFISCALE', 'PARTITAIVAOCODICEFISCALE',
]);
const genericIdHeaders = new Set(['ID', 'IDENTIFICATIVO', 'CODICEIDENTIFICATIVO', 'CODICE']);

export function normalizeIdentifier(value) {
  return String(value ?? '').trim().toUpperCase();
}

async function* fileText(file, phase, onProgress) {
  const reader = file.stream().getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const total = file.size ?? null;
  let loaded = 0;
  let reported = 0;
  let finished = false;
  onProgress({ phase, loaded, total });
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      loaded += value.byteLength;
      if (loaded - reported >= 2 * 1024 * 1024) {
        reported = loaded;
        onProgress({ phase, loaded, total });
      }
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
    onProgress({ phase, loaded, total });
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* jsonRows(chunks) {
  let header = '';
  let trailer = '';
  let started = false;
  let closed = false;
  let commaAllowed = false;
  let emptyAllowed = true;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let partial = '';

  for await (let text of chunks) {
    if (!started) {
      header += text;
      const bindings = /"bindings"\s*:\s*\[/.exec(header);
      if (!bindings) continue;
      if (!/"results"\s*:\s*\{\s*$/.test(header.slice(0, bindings.index))) {
        throw new Error('Intestazione del JSON SPARQL non riconosciuta.');
      }
      text = header.slice(bindings.index + bindings[0].length);
      header = '';
      started = true;
    }

    let start = depth > 0 ? 0 : -1;
    for (let i = 0; i < text.length; i += 1) {
      if (closed) {
        trailer += text.slice(i);
        break;
      }
      const char = text[i];
      if (depth === 0) {
        if (char <= ' ') continue;
        if (char === ']' && (emptyAllowed || commaAllowed)) {
          closed = true;
          continue;
        }
        if (char === ',' && commaAllowed) {
          commaAllowed = false;
          emptyAllowed = false;
          continue;
        }
        if (char !== '{' || commaAllowed) throw new Error('Risultati SPARQL JSON non validi.');
        start = i;
        depth = 1;
        emptyAllowed = false;
      } else if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const value = JSON.parse(partial + text.slice(start, i + 1));
          partial = '';
          start = -1;
          commaAllowed = true;
          yield value;
        }
      }
    }
    if (start >= 0) partial += text.slice(start);
  }

  if (!started || !closed || !/^\s*}\s*}\s*$/.test(trailer)) {
    throw new Error('JSON SPARQL incompleto o non riconosciuto.');
  }
}

function csvDelimiter(text, complete = false) {
  const candidates = [',', ';', '\t'];
  const counts = new Map(candidates.map((delimiter) => [delimiter, 0]));
  let quoted = false;
  let content = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (!quoted && counts.has(char)) counts.set(char, counts.get(char) + 1);
    if (!quoted && (char === '\n' || char === '\r')) {
      if (content) return candidates.reduce((best, key) => counts.get(key) > counts.get(best) ? key : best);
      continue;
    }
    if (char.trim()) content = true;
  }
  return complete ? candidates.reduce((best, key) => counts.get(key) > counts.get(best) ? key : best) : '';
}

async function* csvRows(chunks) {
  let delimiter = '';
  let header = '';
  let row = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let afterCR = false;

  function* consume(text) {
    for (const char of text) {
      if (afterCR) {
        afterCR = false;
        if (char === '\n') continue;
      }
      if (quoted) {
        if (char === '"') {
          quoted = false;
          afterQuote = true;
        } else {
          field += char;
        }
        continue;
      }
      if (afterQuote) {
        afterQuote = false;
        if (char === '"') {
          quoted = true;
          field += '"';
          continue;
        }
      }
      if (char === delimiter) {
        row.push(field);
        field = '';
      } else if (char === '\n' || char === '\r') {
        row.push(field);
        if (row.some((cell) => cell.trim())) yield row;
        row = [];
        field = '';
        afterCR = char === '\r';
      } else if (char === '"' && field === '') {
        quoted = true;
      } else {
        field += char;
      }
    }
  }

  for await (let text of chunks) {
    if (!delimiter) {
      header += text;
      delimiter = csvDelimiter(header);
      if (!delimiter) continue;
      text = header;
      header = '';
    }
    yield* consume(text);
  }
  if (!delimiter) {
    delimiter = csvDelimiter(header, true);
    yield* consume(header);
  }
  if (quoted) throw new Error('CSV incompleto: virgolette non chiuse.');
  row.push(field);
  if (row.some((cell) => cell.trim())) yield row;
}

function readColumns(header) {
  const columns = header.map((value) => value.trim().toLowerCase().replace(/^\?/, ''));
  return tripleColumns.map((choices) => columns.findIndex((name) => choices.has(name)));
}

async function readIds(file, onProgress) {
  let indexes;
  const ids = new Set();
  for await (const row of csvRows(fileText(file, 'elenco', onProgress))) {
    if (!indexes) {
      const headers = row.map((value) => normalizeIdentifier(value).replace(/[^A-Z0-9]/g, ''));
      const explicit = headers.flatMap((value, index) => idHeaders.has(value) ? [index] : []);
      indexes = explicit.length ? explicit : headers.flatMap((value, index) => genericIdHeaders.has(value) ? [index] : []);
      if (indexes.length) continue;
      indexes = [0];
    }
    for (const index of indexes) {
      const id = normalizeIdentifier(row[index]);
      if (id) ids.add(id);
    }
  }
  return ids;
}

function tripleValue(record, field, value) {
  if (!knownFields.has(field)) return;
  if (record[field] === undefined) {
    record[field] = value;
  } else if (Array.isArray(record[field])) {
    if (!record[field].includes(value)) record[field].push(value);
  } else if (record[field] !== value) {
    record[field] = [record[field], value];
  }
}

function applyTriple(records, subject, predicate, object) {
  if (typeof subject !== 'string' || !subject || typeof predicate !== 'string' || !predicate || typeof object !== 'string') {
    throw new Error('Tripla s/p/o mancante o non valida.');
  }
  let record = records.get(subject);
  if (!record) {
    record = { source_subject: subject };
    records.set(subject, record);
  }
  tripleValue(record, predicate.split(/[#/]/).at(-1), object);
}

async function loadDataset(file, phase, onProgress) {
  const records = new Map();
  const chunks = fileText(file, phase, onProgress);
  if (/\.json$/i.test(file.name ?? '')) {
    let keys;
    for await (const row of jsonRows(chunks)) {
      if (!keys) {
        const names = Object.keys(row);
        keys = readColumns(names).map((index) => names[index]);
        if (keys.some((key) => key === undefined)) throw new Error('Variabili s, p, o assenti nel JSON SPARQL.');
      }
      applyTriple(records, ...keys.map((key) => row[key]?.value));
    }
  } else if (/\.csv$/i.test(file.name ?? '')) {
    let columnIndexes;
    let fieldNames;
    for await (const row of csvRows(chunks)) {
      if (!columnIndexes) {
        columnIndexes = readColumns(row);
        if (columnIndexes.includes(-1)) {
          fieldNames = row.map((field) => field.trim().toLowerCase());
          if (!fieldNames.includes('cf_pi')) throw new Error('Intestazione CSV senza le colonne s/p/o o cf_pi.');
        }
        continue;
      }
      if (fieldNames) {
        const record = { source_subject: row[fieldNames.indexOf('source_subject')] ?? '' };
        for (const [index, name] of fieldNames.entries()) {
          if (knownFields.has(name)) record[name] = row[index] ?? '';
        }
        records.set(records.size, record);
      } else {
        applyTriple(records, ...columnIndexes.map((index) => row[index]));
      }
    }
  } else {
    throw new Error('Estensione attesa: .json o .csv.');
  }

  return records;
}

function cleanValues(value) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => String(item ?? '').trim()).filter(Boolean);
}

function verifyKey(values, field) {
  const unique = new Set(values);
  if (unique.size > 1) throw new Error(`Valori diversi di ${field} per lo stesso record.`);
  return values[0] ?? '';
}

function survey(records, useRecord) {
  const identifiers = new Set();
  const years = new Set();
  for (const record of records.values()) {
    const id = verifyKey(cleanValues(record.cf_pi).map(normalizeIdentifier), 'cf_pi');
    const year = verifyKey(cleanValues(record.anno_campagna), 'anno_campagna');
    if (id) identifiers.add(id);
    if (year) years.add(year);
    useRecord(record, id, year);
  }
  return { records: records.size, identifiers: identifiers.size, years: [...years].sort() };
}

function knownProduct(value) {
  return !/^(?:0+|-|NP|ND|N\.[PD]\.?)$/i.test(value);
}

function productTypes(record) {
  const codes = cleanValues(record.codi_prod).filter(knownProduct).map((code) => code.replace(/^0+(?=\d)/, ''));
  const labels = cleanValues(record.desc_prod).filter(knownProduct).map((label) => label.toUpperCase());
  if (!codes.length && !labels.length) return null;
  return {
    olivo: codes.includes('420') || (!codes.length && labels.some((label) => ['OLIVO', 'ULIVO', 'OLIVO DA OLIO', 'OLIVO DA TAVOLA'].includes(label))),
    vite: codes.includes('410') || (!codes.length && labels.some((label) => ['VITE', 'VITE DA VINO', 'VITE DA TAVOLA', 'UVA DA VINO', 'UVA DA TAVOLA'].includes(label))),
  };
}

function joinKey(id, year) {
  return JSON.stringify([id, year]);
}

async function withFileContext(file, action) {
  try {
    return await action();
  } catch (error) {
    throw new Error(`${file.name}: ${error.message}`, { cause: error });
  }
}

export async function importSnapshot({ date, aziende, colture, elenco }, onProgress = () => {}) {
  const ids = await withFileContext(elenco, () => readIds(elenco, onProgress));
  const cropsByCompanyAndYear = new Map();
  const cropStats = await withFileContext(colture, async () => {
    const cropRecords = await loadDataset(colture, 'colture', onProgress);
    return survey(cropRecords, (record, id, year) => {
      if (!id || !year || !ids.has(id)) return;
      const types = productTypes(record);
      if (!types) return;
      const key = joinKey(id, year);
      const current = cropsByCompanyAndYear.get(key);
      if (current) {
        current.olivo ||= types.olivo;
        current.vite ||= types.vite;
      } else {
        cropsByCompanyAndYear.set(key, types);
      }
    });
  });

  const companies = [];
  const present = new Set();
  const companyStats = await withFileContext(aziende, async () => {
    const companyRecords = await loadDataset(aziende, 'aziende', onProgress);
    return survey(companyRecords, (record, id, year) => {
      if (!id || !ids.has(id)) return;
      present.add(id);
      const indicators = year ? cropsByCompanyAndYear.get(joinKey(id, year)) : undefined;
      const row = Object.fromEntries(companyFields.map((key) => [key, cleanValues(record[key]).join(' · ')]));
      companies.push({
        ...row,
        cf_pi: id,
        anno_campagna: year,
        olivo: indicators ? Number(indicators.olivo) : 'NP',
        vite: indicators ? Number(indicators.vite) : 'NP',
        source_subject: record.source_subject,
      });
    });
  });

  return {
    date,
    ids: [...ids],
    missing: [...ids].filter((id) => !present.has(id)),
    companies,
    stats: { aziende: companyStats, colture: cropStats },
  };
}
