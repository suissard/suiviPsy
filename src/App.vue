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
const residentsFileStatus = ref('');
const residentsDropZoneState = ref(''); // 'success' or 'error'
const evaluationsFileStatus = ref('');
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
  const fileInput = type === 'resident' ? document.getElementById('residentsFile') : document.getElementById('evaluationsFile');
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
const normalizeResidentName = (name) => typeof name !== 'string' ? '' : name.replace(/\s*\\n\s*/g, ' ').replace(/^(Mme\\.|M\\.|Monsieur|Madame)\s*/, '').split(' Née ')[0].split(' (')[0].trim();
const getMmseInterpretation = (scoreStr) => {
    const score = parseInt(scoreStr, 10);
    if (isNaN(score)) return { interpretation: scoreStr || "N/A", risk: "Inconnu" };
    if (score <= 10) return { interpretation: "Suspicion d'un syndrome démentiel sévère.", risk: "Démence" };
    if (score <= 18) return { interpretation: "Suspicion d'un syndrome démentiel modéré.", risk: "Démence" };
    if (score <= 24) return { interpretation: "Suspicion d'un syndrome démentiel léger.", risk: "Démence" };
    return { interpretation: "Absence de trouble cognitif.", risk: null };
};
const getGdsInterpretation = (scoreStr) => {
    const score = parseInt(scoreStr, 10);
    if (isNaN(score)) return { interpretation: scoreStr || "N/A", risk: "Inconnu" };
    if (score >= 10) return { interpretation: "Très forte probabilité de dépression.", risk: "Dépression" };
    if (score >= 5) return { interpretation: "Forte probabilité de dépression.", risk: "Dépression" };
    return { interpretation: "Aucun risque de dépression.", risk: null };
};

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
      const result = typeof resultRaw === 'string' ? (resultRaw.match(/^\\d+/) || [resultRaw])[0] : resultRaw;

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
        mmseInterp: evals.MMSE ? getMmseInterpretation(evals.MMSE.result) : null,
        gdsInterp: evals.GDS ? getGdsInterpretation(evals.GDS.result) : null
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
    'Interprétation MMSE': row.mmseInterp?.interpretation,
    'Interprétation GDS': row.gdsInterp?.interpretation,
  }));
  const worksheet = XLSX.utils.json_to_sheet(dataToExport);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Rapport");
  XLSX.writeFile(workbook, "Rapport_Résidents.xlsx");
}
</script>

<template>
  <div class="min-h-screen flex flex-col items-center py-8 px-4 bg-slate-50 text-slate-800">
    <!-- Input Section -->
    <div class="w-full max-w-4xl bg-white p-6 md:p-8 rounded-2xl shadow-lg">
      <div class="grid md:grid-cols-2 gap-6">
        <!-- Residents File Input -->
        <div class="flex flex-col">
          <label for="residentsFile" class="mb-2 font-semibold text-slate-700">1. Fichier des Résidents (.xlsx,
            .csv)</label>
          <div :class="['file-drop-area', 'border-2', 'border-dashed', 'border-slate-300', 'rounded-lg', 'p-4', 'text-center', 'cursor-pointer', residentsDropZoneState]"
            @click="document.getElementById('residentsFile').click()" @dragover="e => setupDragDrop(e, 'resident')"
            @dragleave="() => resetDropZoneState('resident')" @drop="e => handleDrop(e, 'resident')">
            <input type="file" id="residentsFile"
              accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              class="hidden" @change="e => handleFileSelect(e, 'resident')">
            <svg class="mx-auto h-10 w-10 text-slate-400" stroke="currentColor" fill="none" viewBox="0 0 24 24"
              aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
                d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <p class="mt-2 text-sm text-slate-500"><span class="font-semibold text-blue-600">Choisissez un
                fichier</span> ou glissez-déposez</p>
            <p class="text-xs text-slate-500 mt-1 truncate">{{ residentsFileStatus }}</p>
          </div>
        </div>

        <!-- Evaluations File Input -->
        <div class="flex flex-col">
          <label for="evaluationsFile" class="mb-2 font-semibold text-slate-700">2. Fichier des Évaluations (.xlsx,
            .csv)</label>
          <div :class="['file-drop-area', 'border-2', 'border-dashed', 'border-slate-300', 'rounded-lg', 'p-4', 'text-center', 'cursor-pointer', evaluationsDropZoneState]"
            @click="document.getElementById('evaluationsFile').click()" @dragover="e => setupDragDrop(e, 'evaluation')"
            @dragleave="() => resetDropZoneState('evaluation')" @drop="e => handleDrop(e, 'evaluation')">
            <input type="file" id="evaluationsFile"
              accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              class="hidden" @change="e => handleFileSelect(e, 'evaluation')">
            <svg class="mx-auto h-10 w-10 text-slate-400" stroke="currentColor" fill="none" viewBox="0 0 24 24"
              aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1"
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <p class="mt-2 text-sm text-slate-500"><span class="font-semibold text-blue-600">Choisissez un
                fichier</span> ou glissez-déposez</p>
            <p class="text-xs text-slate-500 mt-1 truncate">{{ evaluationsFileStatus }}</p>
          </div>
        </div>
      </div>

      <div class="mt-8 text-center">
        <button @click="generateReport" :disabled="isGenerateBtnDisabled"
          class="bg-blue-600 text-white font-bold py-3 px-8 rounded-lg shadow-md hover:bg-blue-700 transition-transform transform hover:scale-105 disabled:bg-slate-400 disabled:cursor-not-allowed disabled:scale-100">
          {{ generating ? 'Génération en cours...' : 'Générer le rapport' }}
        </button>
      </div>
      <p v-if="errorMessage" class="text-red-500 text-center mt-4 text-sm font-medium">{{ errorMessage }}</p>
    </div>

    <!-- Output Section -->
    <div v-if="outputSectionVisible" class="w-full max-w-full mt-10">
      <div class="bg-white p-6 md:p-8 rounded-2xl shadow-lg">
        <div class="flex flex-wrap justify-between items-center mb-6 gap-4">
          <h2 class="text-2xl font-bold text-slate-900">Rapport Généré</h2>
          <div class="action-buttons flex gap-3">
            <button @click="exportReport"
              class="bg-teal-600 text-white font-bold py-2 px-6 rounded-lg shadow-md hover:bg-teal-700 transition-transform transform hover:scale-105 flex items-center gap-2">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd"
                  d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zM6.293 6.707a1 1 0 010-1.414l3-3a1 1 0 011.414 0l3 3a1 1 0 01-1.414 1.414L11 5.414V13a1 1 0 11-2 0V5.414L7.707 6.707a1 1 0 01-1.414 0z"
                  clip-rule="evenodd"></path>
              </svg>
              Exporter
            </button>
            <button @click="printReport"
              class="bg-green-600 text-white font-bold py-2 px-6 rounded-lg shadow-md hover:bg-green-700 transition-transform transform hover:scale-105 flex items-center gap-2">
              <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                <path fill-rule="evenodd"
                  d="M5 4v3H4a2 2 0 00-2 2v6a2 2 0 002 2h12a2 2 0 002-2V9a2 2 0 00-2-2h-1V4a2 2 0 00-2-2H7a2 2 0 00-2 2zm8 0H7v3h6V4zm0 8H7v4h6v-4z"
                  clip-rule="evenodd"></path>
              </svg>
              Imprimer
            </button>
          </div>
        </div>
        <div id="print-section" class="overflow-x-auto">
          <table class="min-w-full bg-white border border-slate-200">
            <thead class="bg-slate-100 sticky top-0">
              <tr>
                <th @click="sortData('N° de chambre')" data-column="N° de chambre"
                  :class="{ 'sorted': currentSort.column === 'N° de chambre' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Ch.<span class="sort-indicator">{{ currentSort.column === 'N° de chambre' ? (currentSort.direction
                    === 'asc' ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('fullName')" data-column="fullName"
                  :class="{ 'sorted': currentSort.column === 'fullName' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Nom Prénom<span class="sort-indicator">{{ currentSort.column === 'fullName' ? (currentSort.direction
                    === 'asc' ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('Âge')" data-column="Âge" :class="{ 'sorted': currentSort.column === 'Âge' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Age<span class="sort-indicator">{{ currentSort.column === 'Âge' ? (currentSort.direction === 'asc'
                    ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('birthDate')" data-column="birthDate"
                  :class="{ 'sorted': currentSort.column === 'birthDate' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Naissance<span class="sort-indicator">{{ currentSort.column === 'birthDate' ? (currentSort.direction
                    === 'asc' ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('Entrée')" data-column="Entrée"
                  :class="{ 'sorted': currentSort.column === 'Entrée' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Entrée<span class="sort-indicator">{{ currentSort.column === 'Entrée' ? (currentSort.direction ===
                    'asc' ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('GIR')" data-column="GIR" :class="{ 'sorted': currentSort.column === 'GIR' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  GIR<span class="sort-indicator">{{ currentSort.column === 'GIR' ? (currentSort.direction === 'asc' ?
                    '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('MMSE')" data-column="MMSE" :class="{ 'sorted': currentSort.column === 'MMSE' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  MMSE<span class="sort-indicator">{{ currentSort.column === 'MMSE' ? (currentSort.direction === 'asc'
                    ? '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('GDS')" data-column="GDS" :class="{ 'sorted': currentSort.column === 'GDS' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  GDS<span class="sort-indicator">{{ currentSort.column === 'GDS' ? (currentSort.direction === 'asc' ?
                    '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('RUD')" data-column="RUD" :class="{ 'sorted': currentSort.column === 'RUD' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  RUD<span class="sort-indicator">{{ currentSort.column === 'RUD' ? (currentSort.direction === 'asc' ?
                    '▲' : '▼') : '' }}</span>
                </th>
                <th @click="sortData('NPIES')" data-column="NPIES" :class="{ 'sorted': currentSort.column === 'NPIES' }"
                  class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  NPI-ES<span class="sort-indicator">{{ currentSort.column === 'NPIES' ? (currentSort.direction ===
                    'asc' ? '▲' : '▼') : '' }}</span>
                </th>
                <th class="py-2 px-3 border-b text-left text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  Interprétations</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(resident, index) in processedData" :key="resident.normalizedName"
                :class="[index % 2 === 0 ? 'bg-white' : 'bg-slate-50', 'hover:bg-blue-50']">
                <td class="py-2 px-3 border-b border-slate-200 text-sm">{{ resident['N° de chambre'] || '' }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm font-medium">{{ resident.fullName || '' }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm">{{ resident['Âge'] || '' }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm">{{ formatDate(resident.birthDate) }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm">{{ formatDate(resident['Entrée']) }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm">{{ resident['GIR'] || '' }}</td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm"
                  v-html="resident.evals.MMSE ? `${resident.evals.MMSE.date}<br><b>${resident.evals.MMSE.result}</b>` : 'N/A'">
                </td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm"
                  v-html="resident.evals.GDS ? `${resident.evals.GDS.date}<br><b>${resident.evals.GDS.result}</b>` : 'N/A'">
                </td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm"
                  v-html="resident.evals.RUD ? `${resident.evals.RUD.date}<br><b>${resident.evals.RUD.result}</b>` : 'N/A'">
                </td>
                <td class="py-2 px-3 border-b border-slate-200 text-sm"
                  v-html="resident.evals.NPIES ? `${resident.evals.NPIES.date}<br><b>${resident.evals.NPIES.result}</b>` : 'N/A'">
                </td>
                <td class="py-2 px-3 border-b border-slate-200 text-xs">
                  <span v-if="resident.mmseInterp" v-html="`<b>MMSE:</b> ${resident.mmseInterp.interpretation}<br>`" />
                  <span v-if="resident.gdsInterp" v-html="`<b>GDS:</b> ${resident.gdsInterp.interpretation}`" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Scoped styles can go here if needed, but most are global in style.css */
</style>
