<script setup>
import { ref, computed } from 'vue';
import * as XLSX from 'xlsx';

// --- State ---
const residentsDataCache = ref(null);
const evaluationsDataCache = ref(null);
const processedData = ref([]);
const errorMessage = ref('');
const outputSectionVisible = ref(false);
const generating = ref(false);

const currentSort = ref({ column: 'N° de chambre', direction: 'asc' });

// --- File Handling State ---
const residentsFileInput = ref(null);
const evaluationsFileInput = ref(null);
const residentsFileStatus = ref('Aucun fichier sélectionné');
const residentsDropZoneState = ref(''); // 'success' or 'error'
const evaluationsFileStatus = ref('Aucun fichier sélectionné');
const evaluationsDropZoneState = ref(''); // 'success' or 'error'

// --- Computed Properties ---
const isGenerateBtnDisabled = computed(() => {
  return !(residentsDataCache.value && evaluationsDataCache.value) || generating.value;
});

// --- Drag & Drop ---
function setupDragDrop(e, type) {
  e.preventDefault();
  if (type === 'resident') {
    residentsDropZoneState.value = 'dragover';
  } else {
    evaluationsDropZoneState.value = 'dragover';
  }
}

function handleDrop(e, type) {
  e.preventDefault();
  const fileInput = type === 'resident' ? residentsFileInput.value : evaluationsFileInput.value;
  fileInput.files = e.dataTransfer.files;
  handleFileSelect({ target: fileInput }, type);
  if (type === 'resident') {
    residentsDropZoneState.value = '';
  } else {
    evaluationsDropZoneState.value = '';
  }
}

function resetDropZoneState(type) {
    if (type === 'resident') {
        residentsDropZoneState.value = '';
    } else {
        evaluationsDropZoneState.value = '';
    }
}


// --- File Processing ---
async function handleFileSelect(event, fileType) {
  const file = event.target.files[0];
  if (!file) return;

  const statusRef = fileType === 'resident' ? residentsFileStatus : evaluationsFileStatus;
  const dropZoneStateRef = fileType === 'resident' ? residentsDropZoneState : evaluationsDropZoneState;

  statusRef.value = `Lecture de "${file.name}"...`;
  dropZoneStateRef.value = '';

  try {
    const data = await processFile(file);
    if (fileType === 'resident') {
      residentsDataCache.value = data;
    } else {
      evaluationsDataCache.value = data;
    }
    dropZoneStateRef.value = 'success';
    statusRef.value = `${data.length} lignes lues depuis "${file.name}"`;
  } catch (error) {
    if (fileType === 'resident') residentsDataCache.value = null;
    else evaluationsDataCache.value = null;
    dropZoneStateRef.value = 'error';
    statusRef.value = `Erreur: impossible de lire "${file.name}"`;
    console.error("File processing error:", error);
  }
}

function processFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = event.target.result;
        let jsonData;
        if (file.name.endsWith('.xlsx')) {
          const workbook = XLSX.read(data, { type: 'array', cellDates: true });
          jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
        } else {
          const text = new TextDecoder('iso-8859-1').decode(data);
          const rows = text.split('\\n').filter(row => row.trim());
          if (rows.length < 2) return resolve([]);
          const header = rows[0].split(',').map(h => h.trim().replace(/"/g, ''));
          jsonData = rows.slice(1).map(row => {
            const values = row.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
            return header.reduce((obj, key, i) => ({ ...obj, [key]: (values[i] || '').trim().replace(/"/g, '') }), {});
          });
        }
        resolve(jsonData);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// --- Data Normalization & Interpretation ---
const formatDate = (date) => date instanceof Date ? `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}` : (date || '');

/**
 * Parses a complex resident name string using regex and returns a standardized full name.
 * @param {string} rawName - The raw name string, potentially with line breaks.
 * @returns {string} A cleaned, standardized full name.
 */
function normalizeName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return '';
  }

  // Regex to capture all parts of the name, handling multiple lines and variations.
  const nameRegex = /^"?\s*(?<title>M\.|Mme\.)\s+(?<lastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<firstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*?)\s*(?:\s*Née\s+(?<maidenLastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<maidenFirstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*))?\s*\((?<gender>F|H)\)(?:\s*(?<nir>\d{15})\s*\[NIR\])?\s*"?$/;

  // First, replace all sequences of whitespace characters (including newlines) with a single space.
  const singleLineName = rawName.replace(/\s+/g, ' ').trim();

  const match = singleLineName.match(nameRegex);

  if (!match) {
    // Fallback for names that don't match the complex regex
    return singleLineName.replace(/^(Mme\.|M\.|Monsieur|Madame)\s*/, '').split(' (')[0].replace(/,/g, '').trim();
  }

  const { lastName, firstName, maidenLastName, maidenFirstName } = match.groups;

  // Further clean up each part to ensure consistency
  const clean = (str) => str ? str.replace(/,/g, ' ').replace(/\s+/g, ' ').trim() : '';

  const parts = [
    clean(lastName),
    clean(firstName),
    clean(maidenLastName),
    clean(maidenFirstName)
  ].filter(Boolean); // Filter out any empty parts

  return parts.join(' ');
}

const normalizeResidentName = (name) => normalizeName(name);

// --- Sorting Logic ---
function sortData(column) {
  const newDirection = (currentSort.value.column === column && currentSort.value.direction === 'asc') ? 'desc' : 'asc';
  currentSort.value = { column, direction: newDirection };
  const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  processedData.value.sort((a, b) => {
    let valA = a[column], valB = b[column];
    if (['MMSE', 'GDS', 'RUD', 'NPIES'].includes(column)) {
      valA = a.evals[column]?.dateObj; valB = b.evals[column]?.dateObj;
    }
    if (valA == null) return 1; if (valB == null) return -1;
    const comparison = (valA instanceof Date && valB instanceof Date) ? valA.getTime() - valB.getTime() : collator.compare(String(valA), String(valB));
    return currentSort.value.direction === 'asc' ? comparison : -comparison;
  });
}

// --- Main Generation Logic ---
async function generateReport() {
  if (!residentsDataCache.value || !evaluationsDataCache.value) {
    errorMessage.value = 'Veuillez charger les deux fichiers valides.';
    return;
  }
  errorMessage.value = '';
  generating.value = true;

  try {
    const residentEvals = {};
    evaluationsDataCache.value.forEach(ev => {
      const normalizedName = normalizeResidentName(ev['Résident']);
      if (!normalizedName) return;
      if (!residentEvals[normalizedName]) residentEvals[normalizedName] = {};
      let evDate;
      if (ev['Date'] instanceof Date) { evDate = ev['Date']; }
      else if (typeof ev['Date'] === 'string' && ev['Date'].includes('à')) {
        const parts = ev['Date'].split(' à ');
        const dateParts = parts[0].split('/');
        if (dateParts.length === 3) evDate = new Date(dateParts[2], dateParts[1] - 1, dateParts[0]);
      }
      if (!evDate) return;

      let typeKey = ['MMSE', 'GDS', 'RUD', 'NPI-ES'].find(k => ev['Type'].includes(k.replace('NPI-ES', 'NPIES')));
      if(typeKey === 'NPI-ES') typeKey = 'NPIES';
      const resultRaw = ev['Résultat'];
      let result;
      if (typeof resultRaw === 'string') {
        if (resultRaw.trim() === 'Non évaluable' || resultRaw.trim() === 'Non évaluable Résident non évaluable') {
          result = 'NE';
        } else {
          const match = resultRaw.match(/^\s*\d+/);
          result = match ? match[0].trim() : resultRaw;
        }
      } else {
        result = resultRaw;
      }

      if (typeKey && result != null) {
        const existing = residentEvals[normalizedName][typeKey];
        if (!existing || evDate > existing.dateObj) {
          residentEvals[normalizedName][typeKey] = { date: formatDate(evDate), dateObj: evDate, result: String(result) };
        }
      }
    });

    processedData.value = residentsDataCache.value.map(r => {
      const normalizedName = normalizeResidentName(r['Résident']);
      const evals = residentEvals[normalizedName] || {};
      return {
        'fullName': r['Résident'],
        'normalizedName': normalizedName,
        'N° de chambre': r['N° de chambre'],
        'Âge': r['Âge'],
        'birthDate': r['Date naissance'],
        'Entrée': r['Dernière entrée'] || r['Entrée'],
        'GIR': r['GIR'],
        evals,
      };
    });

    sortData(currentSort.value.column);
    outputSectionVisible.value = true;
  } catch (error) {
    console.error('Error processing files:', error);
    errorMessage.value = 'Une erreur est survenue lors de la combinaison des données.';
  } finally {
    generating.value = false;
  }
}

// --- Action Buttons ---
function printReport() {
  window.print();
}

function exportReport() {
  if (processedData.value.length === 0) return;
  const dataToExport = processedData.value.map(row => ({
    'Ch.': row['N° de chambre'],
    'Nom Prénom': row.fullName,
    'Age': row['Âge'],
    'Naissance': formatDate(row.birthDate),
    'Entrée': formatDate(row['Entrée']),
    'GIR': row.GIR,
    'MMSE Résultat': row.evals.MMSE?.result,
    'MMSE Date': row.evals.MMSE?.date,
    'GDS Résultat': row.evals.GDS?.result,
    'GDS Date': row.evals.GDS?.date,
    'RUD Résultat': row.evals.RUD?.result,
    'RUD Date': row.evals.RUD?.date,
    'NPI-ES Résultat': row.evals.NPIES?.result,
    'NPI-ES Date': row.evals.NPIES?.date,
  }));
  const worksheet = XLSX.utils.json_to_sheet(dataToExport);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Rapport");
  XLSX.writeFile(workbook, "Rapport_Résidents.xlsx");
}
</script>

<template>
  <main class="min-h-screen flex flex-col items-center py-8 px-4 bg-slate-50 text-slate-800">
    <!-- Input Section -->
    <div class="w-full max-w-4xl bg-white p-6 md:p-8 rounded-2xl shadow-lg">
      <div class="grid md:grid-cols-2 gap-x-6 gap-y-4">
        <!-- Residents File Input -->
        <div class="flex flex-col">
          <label for="residentsFile" class="mb-1.5 font-medium text-slate-700 text-sm">1. Fichier des Résidents (.xlsx, .csv)</label>
          <input type="file" id="residentsFile" ref="residentsFileInput" accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" class="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" @change="e => handleFileSelect(e, 'resident')">
        </div>

        <!-- Evaluations File Input -->
        <div class="flex flex-col">
          <label for="evaluationsFile" class="mb-1.5 font-medium text-slate-700 text-sm">2. Fichier des Évaluations (.xlsx, .csv)</label>
          <input type="file" id="evaluationsFile" ref="evaluationsFileInput" accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" class="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100" @change="e => handleFileSelect(e, 'evaluation')">
        </div>
      </div>

      <div class="mt-6 text-center">
        <button @click="generateReport" :disabled="isGenerateBtnDisabled"
          class="bg-blue-600 text-white font-semibold py-2 px-4 rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-150 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed">
          {{ generating ? 'Génération en cours...' : 'Générer le rapport' }}
        </button>
      </div>
      <p v-if="errorMessage" class="text-red-500 text-center mt-4 text-sm font-medium">{{ errorMessage }}</p>
    </div>

    <!-- Output Section -->
    <template v-if="outputSectionVisible">
      <div class="w-full max-w-full mt-8">
        <div class="bg-white p-4 sm:p-6 rounded-xl shadow-lg">
          <div class="flex flex-wrap justify-between items-center mb-4 gap-4">
            <h2 class="text-xl font-semibold text-slate-800">Rapport Généré</h2>
            <div class="action-buttons flex gap-2">
               <button @click="exportReport" class="bg-blue-500 text-white font-semibold py-2 px-4 rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-150 ease-in-out flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                  Exporter
              </button>
              <button @click="printReport" class="bg-blue-500 text-white font-semibold py-2 px-4 rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-all duration-150 ease-in-out flex items-center gap-2">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm7-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"></path></svg>
                  Imprimer
              </button>
            </div>
          </div>
          <div id="print-section" class="overflow-x-auto rounded-lg border border-slate-200/75">
            <table class="min-w-full divide-y divide-slate-200">
              <thead class="bg-slate-100">
                <tr>
                  <th @click="sortData('N° de chambre')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Ch.</th>
                  <th @click="sortData('fullName')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Nom Prénom</th>
                  <th @click="sortData('Âge')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Age</th>
                  <th @click="sortData('birthDate')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Naissance</th>
                  <th @click="sortData('Entrée')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">Entrée</th>
                  <th @click="sortData('GIR')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">GIR</th>
                  <th @click="sortData('MMSE')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">MMSE</th>
                  <th @click="sortData('GDS')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">GDS</th>
                  <th @click="sortData('RUD')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">RUD</th>
                  <th @click="sortData('NPIES')" class="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wider">NPI-ES</th>
                </tr>
              </thead>
              <tbody class="bg-white divide-y divide-slate-200">
                <tr v-for="(resident, index) in processedData" :key="resident.normalizedName" :class="{'bg-slate-50': index % 2 !== 0}">
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ resident['N° de chambre'] || '' }}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ resident.fullName || '' }}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ resident['Âge'] || '' }}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ formatDate(resident.birthDate) }}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ formatDate(resident['Entrée']) }}</td>
                  <td class="px-3 py-2 whitespace-nowrap text-sm text-slate-700">{{ resident['GIR'] || '' }}</td>
                  <td class="px-3 py-2 text-sm text-slate-700" v-html="resident.evals.MMSE ? `${resident.evals.MMSE.date}<br><span class='font-bold'>${resident.evals.MMSE.result}</span>` : 'N/A'"></td>
                  <td class="px-3 py-2 text-sm text-slate-700" v-html="resident.evals.GDS ? `${resident.evals.GDS.date}<br><span class='font-bold'>${resident.evals.GDS.result}</span>` : 'N/A'"></td>
                  <td class="px-3 py-2 text-sm text-slate-700" v-html="resident.evals.RUD ? `${resident.evals.RUD.date}<br><span class='font-bold'>${resident.evals.RUD.result}</span>` : 'N/A'"></td>
                  <td class="px-3 py-2 text-sm text-slate-700" v-html="resident.evals.NPIES ? `${resident.evals.NPIES.date}<br><span class='font-bold'>${resident.evals.NPIES.result}</span>` : 'N/A'"></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
/* Scoped styles can go here if needed, but most are global in style.css */
</style>
