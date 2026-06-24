<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import * as XLSX from 'xlsx';

// --- State ---
const uploadedTables = ref([]);
const errorMessage = ref('');
const infoMessage = ref('');
const generating = ref(false);
const previewLimit = ref(20);
const searchFilter = ref('');

// Dialog states
const previewDialog = ref(false);
const previewTableData = ref({ name: '', headers: [], rows: [] });
const showConfigJsonDialog = ref(false);
const rawConfigJson = ref('');

// Config state
const config = ref({
  primaryTableAlias: '',
  tables: [], // Array of { name, alias }
  tableModifiers: {}, // Object: { [alias]: [ { column, jsCode } ] }
  joins: [], // Array of { secondaryAlias, secondaryColumn, primaryColumn }
  outputColumns: [], // Array of { id, title, jsCode }
});

// Compiled items cache
const compiledModifiers = ref({});
const compiledOutputColumns = ref([]);

// --- Helper Functions in JS Context ---
function formatDate(date) {
  if (!date) return '';
  if (date instanceof Date) {
    return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
  }
  return String(date);
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  try {
    const cleanStr = String(dateStr).trim();
    const parts = cleanStr.split(' à ');
    const dateParts = parts[0].split('/');
    if (dateParts.length === 3) {
      const day = parseInt(dateParts[0], 10);
      const month = parseInt(dateParts[1], 10) - 1;
      const year = parseInt(dateParts[2], 10);
      let hour = 0;
      let min = 0;
      if (parts[1]) {
        const timeParts = parts[1].split('h');
        if (timeParts.length === 2) {
          hour = parseInt(timeParts[0], 10);
          min = parseInt(timeParts[1], 10);
        }
      }
      return new Date(year, month, day, hour, min);
    }
  } catch (e) {}
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function cleanName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) return '';
  const singleLineName = rawName.replace(/\s+/g, ' ').trim();
  // Using standard capture groups to avoid '<' and '>' in script blocks which breaks Vue template parser
  const match = singleLineName.match(/^"?\s*(M\.|Mme\.)\s+([A-Z'-]+(?:\s[A-Z'-]+)*)\s+([A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*?)\s*(?:\s*Née\s+([A-Z'-]+(?:\s[A-Z'-]+)*)\s+([A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*))?\s*\((F|H)\)(?:\s*(\d{15})\s*\[NIR\])?\s*"?$/);
  if (match) {
    const lastName = match[2];
    const firstName = match[3];
    const firstFirst = firstName.split(/[ ,]/)[0];
    return `${lastName.trim()} ${firstFirst.trim()}`.toUpperCase();
  }
  return singleLineName.replace(/^(Mme\.|M\.|Monsieur|Madame)\s*/, '').split(' (')[0].replace(/,/g, '').trim().toUpperCase();
}

// --- Compilers ---
function triggerCompilation() {
  // 1. Compile modifiers
  const modifiersResult = {};
  for (const table of config.value.tables) {
    modifiersResult[table.alias] = {};
    const mods = config.value.tableModifiers[table.alias] || [];
    for (const mod of mods) {
      if (!mod.column || !mod.jsCode) continue;
      try {
        const code = mod.jsCode.trim();
        let fn;
        if (code.startsWith('(') || code.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/) || code.startsWith('function')) {
          fn = new Function(`return (${code})`)();
        } else {
          fn = new Function('value', 'row', 'cleanName', 'formatDate', 'parseDate', code);
        }
        modifiersResult[table.alias][mod.column] = fn;
      } catch (e) {
        modifiersResult[table.alias][mod.column] = () => `[Erreur compil: ${e.message}]`;
      }
    }
  }
  compiledModifiers.value = modifiersResult;

  // 2. Compile output columns
  const outputResult = [];
  const aliases = config.value.tables.map(t => t.alias);
  for (const col of config.value.outputColumns) {
    if (!col.jsCode) continue;
    try {
      const code = col.jsCode.trim();
      let fn;
      const paramNames = ['row', 'joined', 'cleanName', 'formatDate', 'parseDate', ...aliases];

      if (code.startsWith('(') || code.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/) || code.startsWith('function')) {
        const userFn = new Function(`return (${code})`)();
        fn = (row, joined, paramValues) => {
          return userFn(row, joined, cleanName, formatDate, parseDate, ...paramValues);
        };
      } else {
        const compiledFn = new Function(...paramNames, code);
        fn = (row, joined, paramValues) => {
          return compiledFn(row, joined, cleanName, formatDate, parseDate, ...paramValues);
        };
      }

      outputResult.push({
        id: col.id,
        title: col.title,
        fn,
        error: null
      });
    } catch (e) {
      outputResult.push({
        id: col.id,
        title: col.title,
        fn: () => `[Erreur compil: ${e.message}]`,
        error: e.message
      });
    }
  }
  compiledOutputColumns.value = outputResult;
}

// Watch config to compile changes and sync with localStorage
watch(config, () => {
  triggerCompilation();
  saveConfigToLocalStorage();
}, { deep: true });

// --- LocalStorage ---
function saveConfigToLocalStorage() {
  localStorage.setItem('suiviPsy_table_config', JSON.stringify(config.value));
}

function loadConfigFromLocalStorage() {
  const data = localStorage.getItem('suiviPsy_table_config');
  if (data) {
    try {
      config.value = JSON.parse(data);
      // Clean up potential undefined structures
      if (!config.value.tables) config.value.tables = [];
      if (!config.value.tableModifiers) config.value.tableModifiers = {};
      if (!config.value.joins) config.value.joins = [];
      if (!config.value.outputColumns) config.value.outputColumns = [];
      triggerCompilation();
    } catch (e) {
      console.error('Failed to parse localStorage config:', e);
    }
  } else {
    // Set default empty structures
    initializeDefaultConfig();
  }
}

function initializeDefaultConfig() {
  config.value = {
    primaryTableAlias: '',
    tables: [],
    tableModifiers: {},
    joins: [],
    outputColumns: [
      { id: 'col_1', title: 'Nom', jsCode: 'return row["Noms / Prénoms"] || row["Résident"] || "";' }
    ]
  };
}

// --- Data processing computation ---
const processedTables = computed(() => {
  const result = {};
  for (const table of uploadedTables.value) {
    const alias = table.alias;
    const modifiers = compiledModifiers.value[alias] || {};

    result[alias] = table.rows.map(row => {
      const newRow = { ...row };
      for (const [colName, modifierFn] of Object.entries(modifiers)) {
        if (colName in newRow) {
          try {
            // Check if function was compiled with 6 parameters or is custom arrow function
            if (modifierFn.length > 2) {
              newRow[colName] = modifierFn(newRow[colName], row, cleanName, formatDate, parseDate);
            } else {
              newRow[colName] = modifierFn(newRow[colName], row);
            }
          } catch (e) {
            newRow[colName] = `[Erreur: ${e.message}]`;
          }
        }
      }
      return newRow;
    });
  }
  return result;
});

const generatedReportData = computed(() => {
  const primaryAlias = config.value.primaryTableAlias;
  if (!primaryAlias || !processedTables.value[primaryAlias]) {
    return [];
  }

  const primaryRows = processedTables.value[primaryAlias];
  const joinsMap = {};
  for (const j of config.value.joins) {
    joinsMap[j.secondaryAlias] = j;
  }

  return primaryRows.map(primaryRow => {
    const joined = {};
    const paramValues = [];

    for (const table of config.value.tables) {
      const alias = table.alias;
      if (alias === primaryAlias) {
        paramValues.push(primaryRow);
      } else {
        const joinConfig = joinsMap[alias];
        let matches = [];
        if (joinConfig && processedTables.value[alias]) {
          const { secondaryColumn, primaryColumn } = joinConfig;
          const primaryVal = String(primaryRow[primaryColumn] || '').trim();
          matches = processedTables.value[alias].filter(secRow => {
            const secVal = String(secRow[secondaryColumn] || '').trim();
            return secVal === primaryVal;
          });
        }
        joined[alias] = matches;
        paramValues.push(matches);
      }
    }

    const outputRow = { _rawRow: primaryRow, _joined: joined };
    for (const col of compiledOutputColumns.value) {
      try {
        outputRow[col.id] = col.fn(primaryRow, joined, paramValues);
      } catch (e) {
        outputRow[col.id] = `[Erreur: ${e.message}]`;
      }
    }
    return outputRow;
  });
});

const filteredReportData = computed(() => {
  const data = generatedReportData.value;
  if (!searchFilter.value.trim()) return data;

  const q = searchFilter.value.toLowerCase().trim();
  return data.filter(row => {
    return Object.entries(row).some(([key, val]) => {
      if (key.startsWith('_')) return false;
      return String(val).toLowerCase().includes(q);
    });
  });
});

const tableHeaders = computed(() => {
  return compiledOutputColumns.value.map(col => ({
    title: col.title,
    key: col.id,
    sortable: true
  }));
});

// --- Actions ---

// File selection / parsing
function handleFileSelect(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  parseAndAddFiles(files);
}

function triggerFileInput() {
  document.getElementById('file-upload-input').click();
}

function parseAndAddFiles(files) {
  errorMessage.value = '';
  for (const file of files) {
    if (uploadedTables.value.some(t => t.name === file.name)) {
      infoMessage.value = `Fichier déjà chargé: ${file.name}`;
      continue;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = e.target.result;
        let rows = [];
        if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          const sheetName = workbook.SheetNames[0];
          rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        } else {
          // Parse CSV
          const text = new TextDecoder('utf-8').decode(data);
          const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
          if (lines.length > 0) {
            const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            rows = lines.slice(1).map(line => {
              const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
              const cleanValues = values.map(v => v.trim().replace(/^"|"$/g, ''));
              return headers.reduce((obj, key, i) => {
                obj[key] = cleanValues[i] || '';
                return obj;
              }, {});
            });
          }
        }

        if (rows.length === 0) {
          throw new Error('Aucune ligne trouvée dans le fichier.');
        }

        const headersSet = new Set();
        rows.forEach(r => Object.keys(r).forEach(k => headersSet.add(k)));
        const headers = [...headersSet].filter(h => h !== '');

        // Check config aliases
        let tableConfig = config.value.tables.find(t => t.name === file.name);
        if (!tableConfig) {
          const baseName = file.name.split('.')[0];
          let cleanAlias = baseName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
          if (!cleanAlias || /^[0-9]/.test(cleanAlias)) cleanAlias = 'table_' + cleanAlias;
          
          let finalAlias = cleanAlias;
          let counter = 1;
          while (
            config.value.tables.some(t => t.alias === finalAlias) ||
            uploadedTables.value.some(t => t.alias === finalAlias)
          ) {
            finalAlias = `${cleanAlias}_${counter}`;
            counter++;
          }

          tableConfig = { name: file.name, alias: finalAlias };
          config.value.tables.push(tableConfig);
        }

        uploadedTables.value.push({
          id: String(Date.now() + Math.random()),
          name: file.name,
          alias: tableConfig.alias,
          headers,
          rows
        });

        // Initialize empty modifiers list for this alias if none exists
        if (!config.value.tableModifiers[tableConfig.alias]) {
          config.value.tableModifiers[tableConfig.alias] = [];
        }

        // Auto-select primary table if none is set
        if (!config.value.primaryTableAlias) {
          config.value.primaryTableAlias = tableConfig.alias;
        }

        triggerCompilation();
      } catch (err) {
        console.error('File parsing error:', err);
        errorMessage.value = `Erreur lors de la lecture de "${file.name}" : ${err.message}`;
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function removeTable(tableId) {
  const index = uploadedTables.value.findIndex(t => t.id === tableId);
  if (index === -1) return;
  const table = uploadedTables.value[index];
  
  // Remove from uploaded
  uploadedTables.value.splice(index, 1);
  
  // Clean joins
  config.value.joins = config.value.joins.filter(j => j.secondaryAlias !== table.alias);

  // If primary was deleted, assign next or clear
  if (config.value.primaryTableAlias === table.alias) {
    config.value.primaryTableAlias = uploadedTables.value[0]?.alias || '';
  }

  triggerCompilation();
}

function updateTableAlias(table, newAlias) {
  // Validate alias (JS variable compliant)
  const cleanAlias = newAlias.replace(/[^a-zA-Z0-9_]/g, '');
  if (!cleanAlias || /^[0-9]/.test(cleanAlias)) return;

  // Make sure alias is unique
  if (config.value.tables.some(t => t.alias === cleanAlias && t.name !== table.name)) {
    return;
  }

  const oldAlias = table.alias;
  table.alias = cleanAlias;

  // Update in config
  const tableConfig = config.value.tables.find(t => t.name === table.name);
  if (tableConfig) tableConfig.alias = cleanAlias;

  // Update primary table setting
  if (config.value.primaryTableAlias === oldAlias) {
    config.value.primaryTableAlias = cleanAlias;
  }

  // Update joins
  config.value.joins.forEach(j => {
    if (j.secondaryAlias === oldAlias) j.secondaryAlias = cleanAlias;
  });

  // Update modifiers
  if (config.value.tableModifiers[oldAlias]) {
    config.value.tableModifiers[cleanAlias] = config.value.tableModifiers[oldAlias];
    delete config.value.tableModifiers[oldAlias];
  }

  triggerCompilation();
}

// Dialog Previews
function showPreviewDialog(table) {
  previewTableData.value = {
    name: table.name,
    headers: table.headers,
    rows: table.rows.slice(0, 10)
  };
  previewDialog.value = true;
}

// Modifiers management
function addModifier(tableAlias) {
  if (!config.value.tableModifiers[tableAlias]) {
    config.value.tableModifiers[tableAlias] = [];
  }
  config.value.tableModifiers[tableAlias].push({
    column: '',
    jsCode: `// (value, row) => newValue\nif (typeof value !== 'string') return value;\nreturn value.trim();`
  });
  triggerCompilation();
}

function removeModifier(tableAlias, index) {
  if (config.value.tableModifiers[tableAlias]) {
    config.value.tableModifiers[tableAlias].splice(index, 1);
    triggerCompilation();
  }
}

function applyModifierTemplate(mod, templateType) {
  if (templateType === 'uppercase') {
    mod.jsCode = `// Forcer en majuscules\nif (typeof value !== 'string') return '';\nreturn value.toUpperCase().trim();`;
  } else if (templateType === 'trim') {
    mod.jsCode = `// Retirer les espaces superflus\nif (typeof value !== 'string') return '';\nreturn value.replace(/\\s+/g, ' ').trim();`;
  } else if (templateType === 'cleanName') {
    mod.jsCode = `// Nettoyer et standardiser un nom de résident\nreturn cleanName(value);`;
  } else if (templateType === 'extractNumber') {
    mod.jsCode = `// Extraire le premier nombre\nif (typeof value === 'number') return value;\nconst m = String(value).match(/\\d+/);\nreturn m ? parseInt(m[0], 10) : '';`;
  }
  triggerCompilation();
}

// Joins management
function addJoin() {
  const secondaryTables = uploadedTables.value.filter(t => t.alias !== config.value.primaryTableAlias);
  const nextSec = secondaryTables.find(t => !config.value.joins.some(j => j.secondaryAlias === t.alias));
  
  config.value.joins.push({
    secondaryAlias: nextSec ? nextSec.alias : '',
    secondaryColumn: '',
    primaryColumn: ''
  });
}

function removeJoin(index) {
  config.value.joins.splice(index, 1);
}

// Output Columns management
function addOutputColumn() {
  const id = `col_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  config.value.outputColumns.push({
    id,
    title: 'Nouvelle Colonne',
    jsCode: `// (row, joined, ...) => valeur\nreturn row[''] || '';`
  });
  triggerCompilation();
}

// Helper to split using string code instead of '<' char which breaks Vue template parser
const cleanSplitChar = String.fromCharCode(60);

function removeOutputColumn(index) {
  config.value.outputColumns.splice(index, 1);
  triggerCompilation();
}

function moveOutputColumn(index, direction) {
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= config.value.outputColumns.length) return;
  const temp = config.value.outputColumns[index];
  config.value.outputColumns[index] = config.value.outputColumns[targetIndex];
  config.value.outputColumns[targetIndex] = temp;
  triggerCompilation();
}

function applyOutputColumnTemplate(col, templateType) {
  const firstSecAlias = config.value.tables.find(t => t.alias !== config.value.primaryTableAlias)?.alias || 'table_secondaire';

  if (templateType === 'direct') {
    col.jsCode = `// Retourne directement une colonne de la table principale\nreturn row['Nom_de_colonne'] || '';`;
  } else if (templateType === 'count') {
    col.jsCode = `// Nombre de lignes correspondantes dans la table '${firstSecAlias}'\nreturn ${firstSecAlias}.length;`;
  } else if (templateType === 'latest') {
    col.jsCode = `// Récupère la dernière ligne de '${firstSecAlias}' selon une date\nconst list = ${firstSecAlias} || [];\nif (list.length === 0) return 'N/A';\n// Trier par date décroissante (gère formats classiques et objets Date)\nconst sorted = [...list].sort((a, b) => {\n  const dateA = parseDate(a['Date']) || new Date(0);\n  const dateB = parseDate(b['Date']) || new Date(0);\n  return dateB - dateA;\n});\nreturn sorted[0]['Résultat'];`;
  } else if (templateType === 'room_formatter') {
    col.jsCode = `// Formater le numéro de chambre (ex: 12 -> 12A, 13 -> 12B)\nconst rawRoom = row['Chambre / Sous-secteur / Secteur'] || row['N° de chambre'] || '';\nconst splitChar = String.fromCharCode(60);\nconst num = rawRoom.split(splitChar)[0]?.trim() || '';\nif (num.endsWith('13')) return num.replace(/13$/, '12B');\nif (num.endsWith('12')) return num.replace(/12$/, '12A');\nreturn num;`;
  } else if (templateType === 'displayName') {
    col.jsCode = `// Formatage du nom : Civilité NOM Prénom\nconst name = row['Noms / Prénoms'] || row['Résident'] || '';\nreturn cleanName(name);`;
  }
  triggerCompilation();
}

// Config JSON actions
function openConfigJsonDialog() {
  rawConfigJson.value = JSON.stringify(config.value, null, 2);
  showConfigJsonDialog.value = true;
}

function importConfigJson() {
  try {
    const parsed = JSON.parse(rawConfigJson.value);
    if (!parsed || typeof parsed !== 'object') throw new Error('Format JSON invalide');
    
    // Merge/fill empty slots
    if (!parsed.tables) parsed.tables = [];
    if (!parsed.tableModifiers) parsed.tableModifiers = {};
    if (!parsed.joins) parsed.joins = [];
    if (!parsed.outputColumns) parsed.outputColumns = [];

    config.value = parsed;
    triggerCompilation();
    showConfigJsonDialog.value = false;
    infoMessage.value = 'Configuration importée avec succès.';
  } catch (e) {
    alert(`Erreur d'import : ${e.message}`);
  }
}

function exportConfigJson() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(config.value, null, 2));
  const dlAnchorElem = document.createElement('a');
  dlAnchorElem.setAttribute("href", dataStr);
  dlAnchorElem.setAttribute("download", "config_liaison_psy.json");
  dlAnchorElem.click();
}

function resetAll() {
  if (confirm('Voulez-vous vraiment réinitialiser les fichiers et la configuration ?')) {
    uploadedTables.value = [];
    initializeDefaultConfig();
    errorMessage.value = '';
    infoMessage.value = '';
  }
}

// Excel Export
function exportToExcel() {
  const data = filteredReportData.value;
  if (data.length === 0) return;

  const dataToExport = data.map(row => {
    const result = {};
    for (const col of compiledOutputColumns.value) {
      result[col.title] = row[col.id];
    }
    return result;
  });

  const worksheet = XLSX.utils.json_to_sheet(dataToExport);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Rapport");
  XLSX.writeFile(workbook, "Rapport_Combines.xlsx");
}

function printReport() {
  window.print();
}

// Loading Demo Data
async function loadDemoData() {
  generating.value = true;
  errorMessage.value = '';
  infoMessage.value = '';
  try {
    const file1Url = '/données de test/export_tableau_netsoins_seances_evaluations (1)_anonyme.xlsx';
    const file2Url = '/données de test/export_tableau_netsoins_seances_evaluations_anonyme (2).xlsx';

    const [res1, res2] = await Promise.all([
      fetch(file1Url).then(r => {
        if (!r.ok) throw new Error('Fichier 1 introuvable dans public/');
        return r.arrayBuffer();
      }),
      fetch(file2Url).then(r => {
        if (!r.ok) throw new Error('Fichier 2 introuvable dans public/');
        return r.arrayBuffer();
      })
    ]);

    // Parse XLSX 1
    const wb1 = XLSX.read(new Uint8Array(res1), { type: 'array', cellDates: true });
    const rows1 = XLSX.utils.sheet_to_json(wb1.Sheets[wb1.SheetNames[0]]);
    const headers1 = [...new Set(rows1.flatMap(Object.keys))].filter(h => h !== '');

    // Parse XLSX 2
    const wb2 = XLSX.read(new Uint8Array(res2), { type: 'array', cellDates: true });
    const rows2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]);
    const headers2 = [...new Set(rows2.flatMap(Object.keys))].filter(h => h !== '');

    uploadedTables.value = [
      {
        id: 'demo_1',
        name: 'export_tableau_netsoins_seances_evaluations (1)_anonyme.xlsx',
        alias: 'evals1',
        headers: headers1,
        rows: rows1
      },
      {
        id: 'demo_2',
        name: 'export_tableau_netsoins_seances_evaluations_anonyme (2).xlsx',
        alias: 'evals2',
        headers: headers2,
        rows: rows2
      }
    ];

    config.value = {
      primaryTableAlias: 'evals1',
      tables: [
        { name: 'export_tableau_netsoins_seances_evaluations (1)_anonyme.xlsx', alias: 'evals1' },
        { name: 'export_tableau_netsoins_seances_evaluations_anonyme (2).xlsx', alias: 'evals2' }
      ],
      tableModifiers: {
        evals1: [
          {
            column: 'Résident',
            jsCode: `// Nettoyer les sauts de ligne et espaces superflus\nif (typeof value !== 'string') return '';\nreturn value.replace(/\\s+/g, ' ').trim();`
          }
        ],
        evals2: [
          {
            column: 'Résident',
            jsCode: `// Nettoyer les sauts de ligne et espaces superflus\nif (typeof value !== 'string') return '';\nreturn value.replace(/\\s+/g, ' ').trim();`
          }
        ]
      },
      joins: [
        {
          secondaryAlias: 'evals2',
          secondaryColumn: 'Résident',
          primaryColumn: 'Résident'
        }
      ],
      outputColumns: [
        {
          id: 'col_res',
          title: 'Résident (Nettoyé)',
          jsCode: `// Récupère le nom sans le genre et autres détails\nconst rawName = row['Résident'] || '';\nreturn rawName.split(' (')[0].replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim();`
        },
        {
          id: 'col_date1',
          title: 'Date Evals 1',
          jsCode: `return formatDate(row['Date']);`
        },
        {
          id: 'col_type1',
          title: 'Type Evals 1',
          jsCode: `return row['Type'];`
        },
        {
          id: 'col_res1',
          title: 'Résultat Evals 1',
          jsCode: `return row['Résultat'];`
        },
        {
          id: 'col_count2',
          title: 'Nombre Evals 2 liés',
          jsCode: `return evals2.length;`
        },
        {
          id: 'col_det2',
          title: 'Détails Evals 2 liés',
          jsCode: `return evals2.map(e => e['Type'] + ': ' + e['Résultat']).join(' | ');`
        }
      ]
    };

    triggerCompilation();
    infoMessage.value = 'Données et configuration de démonstration chargées.';
  } catch (err) {
    console.error('Error loading demo:', err);
    errorMessage.value = `Erreur lors du chargement des fichiers de démo : ${err.message}`;
  } finally {
    generating.value = false;
  }
}

// Drag & drop support
function handleDragOver(e) {
  e.preventDefault();
}

function handleDrop(e) {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (files && files.length > 0) {
    parseAndAddFiles(files);
  }
}

// Lifecycle
onMounted(() => {
  loadConfigFromLocalStorage();
});
</script>

<template>
  <v-app>
    <!-- App Bar with premium color gradients -->
    <v-app-bar flat style="background: linear-gradient(135deg, #102a43 0%, #1e3a8a 100%)" dark>
      <v-app-bar-title class="font-weight-bold text-white d-flex align-center">
        <v-icon icon="mdi-vector-combine" class="mr-2"></v-icon>
        Mélangeur de Tableaux Dynamique
      </v-app-bar-title>

      <v-spacer></v-spacer>

      <v-btn variant="flat" color="teal-accent-4" class="mr-2 text-none" prepend-icon="mdi-flask-outline" @click="loadDemoData" :loading="generating">
        Charger la Démo
      </v-btn>

      <v-btn variant="outlined" color="white" class="mr-2 text-none" prepend-icon="mdi-code-json" @click="openConfigJsonDialog">
        Config JSON
      </v-btn>

      <v-btn variant="outlined" color="red-lighten-4" class="text-none" prepend-icon="mdi-refresh" @click="resetAll">
        Réinitialiser
      </v-btn>
    </v-app-bar>

    <v-main class="bg-blue-grey-lighten-5">
      <v-container fluid class="pa-4">
        <!-- Error Alerts -->
        <v-alert v-if="errorMessage" type="error" closable class="mb-4" @click:close="errorMessage = ''">
          {{ errorMessage }}
        </v-alert>
        <v-alert v-if="infoMessage" type="info" closable class="mb-4" @click:close="infoMessage = ''">
          {{ infoMessage }}
        </v-alert>

        <v-row>
          <!-- Left Configuration Pane -->
          <v-col cols="12" lg="5">
            <v-expansion-panels multiple variant="accordion" class="elevation-2 rounded-lg">
              
              <!-- SECTION 1: Sources & Aliases -->
              <v-expansion-panel value="sources">
                <v-expansion-panel-title class="font-weight-bold text-blue-darken-4">
                  <v-icon icon="mdi-file-table-outline" class="mr-2"></v-icon>
                  1. Tableaux Sources & Alias
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <!-- Drag & Drop Upload Zone -->
                  <div
                    class="upload-zone text-center pa-6 mb-4 border-dashed rounded-lg cursor-pointer"
                    @dragover="handleDragOver"
                    @drop="handleDrop"
                    @click="triggerFileInput"
                  >
                    <v-icon icon="mdi-cloud-upload-outline" size="48" color="primary"></v-icon>
                    <div class="text-subtitle-1 font-weight-medium mt-2">
                      Glissez-déposez vos fichiers ici
                    </div>
                    <div class="text-caption text-grey">
                      Prend en charge les formats Excel (.xlsx, .xls) et CSV
                    </div>
                    <input
                      type="file"
                      id="file-upload-input"
                      multiple
                      accept=".xlsx,.xls,.csv"
                      style="display: none"
                      @change="handleFileSelect"
                    />
                  </div>

                  <!-- Uploaded tables listing -->
                  <div v-if="uploadedTables.length === 0" class="text-center text-grey py-4">
                    Aucun fichier chargé
                  </div>
                  
                  <v-card
                    v-for="table in uploadedTables"
                    :key="table.id"
                    variant="outlined"
                    class="mb-3 rounded-lg border-blue-grey-lighten-3"
                  >
                    <v-card-item class="pb-1 bg-grey-lighten-4">
                      <div class="d-flex align-center justify-space-between w-100">
                        <div class="text-subtitle-2 font-weight-bold text-truncate" style="max-width: 250px;">
                          {{ table.name }}
                        </div>
                        <div>
                          <v-btn icon="mdi-eye" size="x-small" variant="text" color="blue" class="mr-1" @click="showPreviewDialog(table)"></v-btn>
                          <v-btn icon="mdi-delete" size="x-small" variant="text" color="red" @click="removeTable(table.id)"></v-btn>
                        </div>
                      </div>
                    </v-card-item>
                    <v-card-text class="pt-2">
                      <v-row dense align="center">
                        <v-col cols="6">
                          <v-text-field
                            label="Alias JS (unique)"
                            :model-value="table.alias"
                            @update:model-value="val => updateTableAlias(table, val)"
                            density="compact"
                            variant="outlined"
                            hide-details
                            prefix="v."
                            class="font-mono"
                          ></v-text-field>
                        </v-col>
                        <v-col cols="6" class="text-caption text-grey text-right">
                          <div>{{ table.rows.length }} lignes</div>
                          <div>{{ table.headers.length }} colonnes</div>
                        </v-col>
                      </v-row>
                    </v-card-text>
                  </v-card>
                </v-expansion-panel-text>
              </v-expansion-panel>

              <!-- SECTION 2: Data modifiers (Normalization) -->
              <v-expansion-panel value="modifiers">
                <v-expansion-panel-title class="font-weight-bold text-blue-darken-4">
                  <v-icon icon="mdi-code-braces" class="mr-2"></v-icon>
                  2. Normalisation / Modificateurs JS (Optionnel)
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="text-caption mb-3">
                    Modifiez la valeur d'une colonne en JS avant de lier les tableaux (ex. supprimer "Mme.", nettoyer les espaces).
                  </div>

                  <div v-if="uploadedTables.length === 0" class="text-center text-grey py-2">
                    Chargez d'abord des fichiers sources
                  </div>

                  <div v-for="table in uploadedTables" :key="'mod-' + table.id" class="mb-4">
                    <div class="d-flex align-center justify-space-between mb-2">
                      <div class="font-weight-bold text-subtitle-2 text-primary">
                        Tableau : {{ table.name }} (Alias: {{ table.alias }})
                      </div>
                      <v-btn size="x-small" color="primary" prepend-icon="mdi-plus" variant="text" @click="addModifier(table.alias)">
                        Ajouter
                      </v-btn>
                    </div>

                    <div v-if="!config.value.tableModifiers[table.alias] || config.value.tableModifiers[table.alias].length === 0" class="text-caption text-grey ml-4">
                      Aucun modificateur
                    </div>

                    <v-card
                      v-for="(mod, index) in (config.value.tableModifiers[table.alias] || [])"
                      :key="index"
                      variant="tonal"
                      color="blue-grey"
                      class="mb-2 pa-2 rounded-lg"
                    >
                      <v-row dense align="center" class="mb-1">
                        <v-col cols="8">
                          <v-select
                            v-model="mod.column"
                            :items="table.headers"
                            label="Colonne cible"
                            density="compact"
                            variant="outlined"
                            hide-details
                          ></v-select>
                        </v-col>
                        <v-col cols="4" class="text-right">
                          <v-btn icon="mdi-delete" size="x-small" color="red" variant="text" @click="removeModifier(table.alias, index)"></v-btn>
                        </v-col>
                      </v-row>
                      
                      <!-- Code Templates Buttons -->
                      <div class="d-flex flex-wrap gap-1 my-1">
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyModifierTemplate(mod, 'trim')">Nettoyer Espaces</v-btn>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyModifierTemplate(mod, 'uppercase')">MAJUSCULE</v-btn>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyModifierTemplate(mod, 'cleanName')">Standardiser Noms</v-btn>
                        <v-btn size="x-small" variant="outlined" class="text-none" @click="applyModifierTemplate(mod, 'extractNumber')">Extraire Nombre</v-btn>
                      </div>

                      <v-textarea
                        v-model="mod.jsCode"
                        label="Code de modification JS"
                        density="compact"
                        rows="3"
                        variant="outlined"
                        hide-details
                        class="mt-1 font-mono"
                        style="font-size: 12px;"
                      ></v-textarea>
                    </v-card>
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>

              <!-- SECTION 3: Joins (Linkage) -->
              <v-expansion-panel value="joins">
                <v-expansion-panel-title class="font-weight-bold text-blue-darken-4">
                  <v-icon icon="mdi-link-variant" class="mr-2"></v-icon>
                  3. Liaisons (Joins)
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="text-caption mb-3">
                    Définissez la table principale (qui définit les lignes du rapport) et comment lier les autres tables.
                  </div>

                  <v-row dense align="center" class="mb-4">
                    <v-col cols="12">
                      <v-select
                        v-model="config.primaryTableAlias"
                        :items="uploadedTables"
                        item-title="name"
                        item-value="alias"
                        label="Tableau principal (Base)"
                        density="compact"
                        variant="outlined"
                        hide-details
                      ></v-select>
                    </v-col>
                  </v-row>

                  <div class="d-flex align-center justify-space-between mb-2">
                    <div class="text-subtitle-2 font-weight-bold">Tables secondaires liées</div>
                    <v-btn
                      v-if="uploadedTables.length > 1"
                      size="x-small"
                      color="primary"
                      prepend-icon="mdi-plus"
                      variant="text"
                      @click="addJoin"
                    >
                      Ajouter liaison
                    </v-btn>
                  </div>

                  <div v-if="config.joins.length === 0" class="text-center text-grey py-2 text-caption">
                    Aucune liaison définie
                  </div>

                  <v-card
                    v-for="(join, index) in config.joins"
                    :key="index"
                    variant="outlined"
                    class="mb-3 pa-2 rounded-lg border-blue-lighten-4"
                  >
                    <div class="d-flex justify-space-between align-center mb-2">
                      <span class="text-caption font-weight-bold text-blue">Liaison #{{ index + 1 }}</span>
                      <v-btn icon="mdi-delete" size="x-small" color="red" variant="text" @click="removeJoin(index)"></v-btn>
                    </div>

                    <v-row dense>
                      <v-col cols="12">
                        <v-select
                          v-model="join.secondaryAlias"
                          :items="uploadedTables.filter(t => t.alias !== config.primaryTableAlias)"
                          item-title="name"
                          item-value="alias"
                          label="Lier la table secondaire"
                          density="compact"
                          variant="outlined"
                          hide-details
                          class="mb-2"
                        ></v-select>
                      </v-col>
                    </v-row>

                    <v-row dense v-if="join.secondaryAlias">
                      <v-col cols="5">
                        <v-select
                          v-model="join.secondaryColumn"
                          :items="uploadedTables.find(t => t.alias === join.secondaryAlias)?.headers || []"
                          label="Clé secondaire"
                          density="compact"
                          variant="outlined"
                          hide-details
                          style="font-size: 12px;"
                        ></v-select>
                      </v-col>
                      <v-col cols="2" class="d-flex align-center justify-center font-weight-bold text-grey">
                        ==
                      </v-col>
                      <v-col cols="5">
                        <v-select
                          v-model="join.primaryColumn"
                          :items="uploadedTables.find(t => t.alias === config.primaryTableAlias)?.headers || []"
                          label="Clé principale"
                          density="compact"
                          variant="outlined"
                          hide-details
                          style="font-size: 12px;"
                        ></v-select>
                      </v-col>
                    </v-row>
                  </v-card>
                </v-expansion-panel-text>
              </v-expansion-panel>

              <!-- SECTION 4: Output Columns -->
              <v-expansion-panel value="columns">
                <v-expansion-panel-title class="font-weight-bold text-blue-darken-4">
                  <v-icon icon="mdi-table-column-width" class="mr-2"></v-icon>
                  4. Colonnes du Rapport Final
                </v-expansion-panel-title>
                <v-expansion-panel-text>
                  <div class="text-caption mb-3">
                    Configurez les colonnes à afficher. Utilisez du JS pour extraire et combiner les données. 
                    Variables dispo : <code class="bg-grey-lighten-2 px-1 rounded">row</code> (ligne principale), <code class="bg-grey-lighten-2 px-1 rounded">joined</code> (liaisons), ainsi que les alias de tableaux (ex: <code class="bg-grey-lighten-2 px-1 rounded">evals1</code>).
                  </div>

                  <div class="d-flex justify-end mb-2">
                    <v-btn
                      size="x-small"
                      color="primary"
                      prepend-icon="mdi-plus"
                      variant="flat"
                      @click="addOutputColumn"
                    >
                      Ajouter une colonne
                    </v-btn>
                  </div>

                  <div v-if="config.outputColumns.length === 0" class="text-center text-grey py-4">
                    Aucune colonne configurée
                  </div>

                  <!-- Output columns cards list -->
                  <div class="output-columns-list">
                    <v-card
                      v-for="(col, index) in config.outputColumns"
                      :key="col.id"
                      variant="outlined"
                      class="mb-3 pa-2 rounded-lg border-blue-grey-lighten-2"
                    >
                      <v-row dense align="center">
                        <v-col cols="5">
                          <v-text-field
                            v-model="col.title"
                            label="Titre de la colonne"
                            density="compact"
                            variant="outlined"
                            hide-details
                            class="font-weight-bold"
                          ></v-text-field>
                        </v-col>
                        <v-col cols="7" class="d-flex justify-end align-center">
                          <v-btn icon="mdi-chevron-up" size="x-small" variant="text" :disabled="index === 0" @click="moveOutputColumn(index, -1)"></v-btn>
                          <v-btn icon="mdi-chevron-down" size="x-small" variant="text" :disabled="index === config.outputColumns.length - 1" @click="moveOutputColumn(index, 1)"></v-btn>
                          <v-btn icon="mdi-delete" size="x-small" color="red" variant="text" @click="removeOutputColumn(index)"></v-btn>
                        </v-col>
                      </v-row>

                      <!-- Express template buttons -->
                      <div class="d-flex flex-wrap gap-1 my-2">
                        <span class="text-caption text-grey mr-2 d-flex align-center">Modèles :</span>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyOutputColumnTemplate(col, 'direct')">Valeur Simple</v-btn>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyOutputColumnTemplate(col, 'count')">Compte de lignes</v-btn>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyOutputColumnTemplate(col, 'latest')">Dernière Valeur</v-btn>
                        <v-btn size="x-small" variant="outlined" class="mr-1 text-none" @click="applyOutputColumnTemplate(col, 'room_formatter')">Chambre A/B</v-btn>
                        <v-btn size="x-small" variant="outlined" class="text-none" @click="applyOutputColumnTemplate(col, 'displayName')">Standardiser Nom</v-btn>
                      </div>

                      <v-textarea
                        v-model="col.jsCode"
                        label="Formule JS de la colonne"
                        density="compact"
                        rows="4"
                        variant="outlined"
                        hide-details
                        class="font-mono text-caption"
                        style="font-size: 11px;"
                      ></v-textarea>
                    </v-card>
                  </div>
                </v-expansion-panel-text>
              </v-expansion-panel>

            </v-expansion-panels>
          </v-col>

          <!-- Right Results / Preview Pane -->
          <v-col cols="12" lg="7">
            <v-card class="elevation-2 rounded-lg h-100 d-flex flex-column">
              <v-card-title class="bg-blue-grey-darken-4 text-white d-flex align-center flex-wrap py-2">
                <v-icon icon="mdi-table-eye" class="mr-2"></v-icon>
                <span>5. Rapport Généré (Temps Réel)</span>
                <v-spacer></v-spacer>
                
                <div class="d-flex align-center flex-wrap gap-2 mt-2 mt-sm-0">
                  <v-btn
                    color="success"
                    class="text-none mr-2"
                    prepend-icon="mdi-file-excel-outline"
                    @click="exportToExcel"
                    :disabled="filteredReportData.length === 0"
                    size="small"
                  >
                    Exporter XLSX
                  </v-btn>
                  <v-btn
                    color="blue-grey-lighten-4"
                    class="text-none text-black"
                    prepend-icon="mdi-printer"
                    @click="printReport"
                    :disabled="filteredReportData.length === 0"
                    size="small"
                  >
                    Imprimer
                  </v-btn>
                </div>
              </v-card-title>

              <v-card-text class="pa-4 flex-grow-1 d-flex flex-column">
                <v-row dense class="mb-3" align="center">
                  <v-col cols="12" sm="6">
                    <v-text-field
                      v-model="searchFilter"
                      prepend-inner-icon="mdi-magnify"
                      label="Rechercher dans le rapport..."
                      density="compact"
                      variant="outlined"
                      hide-details
                      clearable
                    ></v-text-field>
                  </v-col>
                  <v-col cols="12" sm="6" class="text-right">
                    <v-select
                      v-model="previewLimit"
                      :items="[10, 20, 50, 100, -1]"
                      label="Afficher"
                      density="compact"
                      variant="outlined"
                      hide-details
                      style="max-width: 150px; display: inline-block;"
                    >
                      <template v-slot:selection="{ item }">
                        {{ item.value === -1 ? 'Tout' : item.value + ' lignes' }}
                      </template>
                      <template v-slot:item="{ item, props }">
                        <v-list-item v-bind="props" :title="item.value === -1 ? 'Tout' : item.value + ' lignes'"></v-list-item>
                      </template>
                    </v-select>
                    <span class="text-caption text-grey ml-3">
                      Total : {{ filteredReportData.length }} lignes
                    </span>
                  </v-col>
                </v-row>

                <!-- Generated table preview container -->
                <div class="table-container flex-grow-1 overflow-auto rounded border" style="max-height: 550px;">
                  <table class="custom-data-table w-100">
                    <thead>
                      <tr>
                        <th v-for="header in tableHeaders" :key="header.key" class="text-left font-weight-bold px-3 py-2 bg-grey-lighten-3 text-subtitle-2 border-bottom">
                          {{ header.title }}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-if="filteredReportData.length === 0">
                        <td :colspan="tableHeaders.length" class="text-center text-grey py-8">
                          Aucun résultat à afficher. Vérifiez vos liaisons et la table principale.
                        </td>
                      </tr>
                      <tr
                        v-for="(row, rowIndex) in filteredReportData.slice(0, previewLimit === -1 ? undefined : previewLimit)"
                        :key="rowIndex"
                        class="border-bottom hover-row"
                      >
                        <td
                          v-for="header in tableHeaders"
                          :key="header.key"
                          class="px-3 py-2 text-body-2"
                        >
                          <span v-if="String(row[header.key]).startsWith('[Erreur:')" class="text-red font-weight-bold d-flex align-center">
                            <v-icon icon="mdi-alert-circle-outline" size="small" class="mr-1"></v-icon>
                            <v-tooltip :text="String(row[header.key])" location="top">
                              <template v-slot:activator="{ props }">
                                <span v-bind="props" class="cursor-help text-decoration-underline">Script Erreur</span>
                              </template>
                            </v-tooltip>
                          </span>
                          <span v-else>{{ row[header.key] }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>
      </v-container>
    </v-main>

    <!-- Dialogs -->

    <!-- File raw preview dialog -->
    <v-dialog v-model="previewDialog" max-width="800px">
      <v-card class="rounded-lg">
        <v-card-title class="bg-blue-grey-lighten-4 d-flex justify-space-between align-center">
          <span class="font-weight-bold text-truncate">Aperçu : {{ previewTableData.name }} (10 premières lignes)</span>
          <v-btn icon="mdi-close" variant="text" size="small" @click="previewDialog = false"></v-btn>
        </v-card-title>
        <v-card-text class="pa-0 overflow-auto" style="max-height: 500px;">
          <v-table density="compact">
            <thead>
              <tr>
                <th v-for="h in previewTableData.headers" :key="h" class="text-left font-weight-bold bg-grey-lighten-3">
                  {{ h }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in previewTableData.rows" :key="i">
                <td v-for="h in previewTableData.headers" :key="h">
                  {{ r[h] }}
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- Config JSON dialog -->
    <v-dialog v-model="showConfigJsonDialog" max-width="700px">
      <v-card class="rounded-lg">
        <v-card-title class="bg-blue-grey-lighten-4 d-flex justify-space-between align-center">
          <span class="font-weight-bold">Importer / Exporter la Configuration (JSON)</span>
          <v-btn icon="mdi-close" variant="text" size="small" @click="showConfigJsonDialog = false"></v-btn>
        </v-card-title>
        <v-card-text class="pa-4">
          <div class="text-caption mb-3 text-grey-darken-2">
            Copiez ce texte JSON pour sauvegarder ou partager votre configuration, ou collez-en un ici pour l'importer.
          </div>
          <v-textarea
            v-model="rawConfigJson"
            rows="15"
            variant="outlined"
            class="font-mono"
            style="font-size: 12px"
            label="JSON Configuration"
          ></v-textarea>
        </v-card-text>
        <v-card-actions class="pa-4 pt-0">
          <v-btn color="primary" class="text-none" @click="importConfigJson" variant="flat">
            Importer ce JSON
          </v-btn>
          <v-spacer></v-spacer>
          <v-btn color="secondary" class="text-none" @click="exportConfigJson" variant="outlined">
            Télécharger le fichier JSON
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style scoped>
.upload-zone {
  border: 2px dashed #90a4ae;
  transition: all 0.3s ease;
  background-color: #f8fafc;
}
.upload-zone:hover {
  border-color: #1e3a8a;
  background-color: #f1f5f9;
}
.custom-data-table {
  border-collapse: collapse;
}
.custom-data-table th, .custom-data-table td {
  border-bottom: 1px solid #e2e8f0;
}
.hover-row:hover {
  background-color: #f8fafc;
}
.font-mono {
  font-family: Consolas, Monaco, 'Courier New', Courier, monospace !important;
}
.cursor-pointer {
  cursor: pointer;
}
.cursor-help {
  cursor: help;
}
.border-dashed {
  border-style: dashed !important;
}
.gap-1 {
  gap: 4px;
}
.gap-2 {
  gap: 8px;
}
.w-100 {
  width: 100%;
}
</style>
