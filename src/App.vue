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

const residentsFile = ref(null);
const evaluationsFile = ref(null);

// --- Computed Properties ---
const isGenerateBtnDisabled = computed(() => {
  return !(residentsDataCache.value && evaluationsDataCache.value) || generating.value;
});

// --- File Processing ---
async function handleFileSelect(files, fileType) {
  const file = files[0];
  if (!file) {
    if (fileType === 'resident') {
      residentsDataCache.value = null;
    } else {
      evaluationsDataCache.value = null;
    }
    return;
  }

  try {
    const data = await processFile(file);
    if (fileType === 'resident') {
      residentsDataCache.value = data;
    } else {
      evaluationsDataCache.value = data;
    }
  } catch (error) {
    if (fileType === 'resident') residentsDataCache.value = null;
    else evaluationsDataCache.value = null;
    errorMessage.value = `Erreur: impossible de lire "${file.name}"`;
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

function normalizeName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return '';
  }
  const singleLineName = rawName.replace(/\s+/g, ' ').trim();
  const nameRegex = /^"?\s*(?<title>M\.|Mme\.)\s+(?<lastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<firstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*?)\s*(?:\s*Née\s+(?<maidenLastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<maidenFirstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*))?\s*\((?<gender>F|H)\)(?:\s*(?<nir>\d{15})\s*\[NIR\])?\s*"?$/;
  const match = singleLineName.match(nameRegex);
  if (!match) {
    return singleLineName.replace(/^(Mme\.|M\.|Monsieur|Madame)\s*/, '').split(' (')[0].replace(/,/g, '').trim();
  }
  const { lastName, firstName, maidenLastName, maidenFirstName } = match.groups;
  const clean = (str) => str ? str.replace(/,/g, ' ').replace(/\s+/g, ' ').trim() : '';
  const parts = [clean(lastName), clean(firstName), clean(maidenLastName), clean(maidenFirstName)].filter(Boolean);
  return parts.join(' ');
}

const normalizeResidentName = (name) => normalizeName(name);

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

const headers = [
  { title: 'Ch.', key: 'N° de chambre', align: 'start', sortable: true },
  { title: 'Nom Prénom', key: 'fullName', align: 'start', sortable: true },
  { title: 'Age', key: 'Âge', align: 'start', sortable: true },
  { title: 'Naissance', key: 'birthDate', align: 'start', sortable: true, value: item => formatDate(item.birthDate) },
  { title: 'Entrée', key: 'Entrée', align: 'start', sortable: true, value: item => formatDate(item['Entrée']) },
  { title: 'GIR', key: 'GIR', align: 'start', sortable: true },
  { title: 'MMSE', key: 'evals.MMSE', align: 'center', sortable: false, },
  { title: 'GDS', key: 'evals.GDS', align: 'center', sortable: false, },
  { title: 'RUD', key: 'evals.RUD', align: 'center', sortable: false, },
  { title: 'NPI-ES', key: 'evals.NPIES', align: 'center', sortable: false, },
]
</script>

<template>
  <v-app>
    <v-main class="bg-grey-lighten-4">
      <v-container>
        <v-card class="mx-auto pa-4" max-width="900">
          <v-card-title class="text-h4 text-center font-weight-bold my-4">Générateur de Rapport</v-card-title>
          <v-card-text>
            <v-row>
              <v-col cols="12" md="6">
                <v-file-input
                  v-model="residentsFile"
                  label="1. Fichier des Résidents (.xlsx, .csv)"
                  accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  @update:modelValue="files => handleFileSelect(files, 'resident')"
                  prepend-icon="mdi-account-group"
                  variant="outlined"
                  clearable
                ></v-file-input>
              </v-col>
              <v-col cols="12" md="6">
                <v-file-input
                  v-model="evaluationsFile"
                  label="2. Fichier des Évaluations (.xlsx, .csv)"
                  accept=".csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  @update:modelValue="files => handleFileSelect(files, 'evaluation')"
                   prepend-icon="mdi-file-chart"
                   variant="outlined"
                   clearable
                ></v-file-input>
              </v-col>
            </v-row>
            <div class="text-center mt-4">
              <v-btn
                @click="generateReport"
                :disabled="isGenerateBtnDisabled"
                :loading="generating"
                color="primary"
                size="large"
                elevation="2"
              >
                Générer le rapport
              </v-btn>
            </div>
            <v-alert v-if="errorMessage" type="error" class="mt-4" dense closable @input="errorMessage = ''">{{ errorMessage }}</v-alert>
          </v-card-text>
        </v-card>

        <v-card v-if="outputSectionVisible" class="mx-auto mt-8">
          <v-card-title class="d-flex align-center pe-2">
            <h2 class="text-h5">Rapport Généré</h2>
            <v-spacer></v-spacer>
            <v-btn @click="exportReport" color="secondary" class="mr-2" prepend-icon="mdi-download" variant="tonal">Exporter</v-btn>
            <v-btn @click="printReport" color="secondary" prepend-icon="mdi-printer" variant="tonal">Imprimer</v-btn>
          </v-card-title>
          <v-divider></v-divider>
          <v-card-text class="pa-0">
            <v-data-table
              :headers="headers"
              :items="processedData"
              class="elevation-0"
              item-key="normalizedName"
              :items-per-page="10"
              :footer-props="{
                'items-per-page-options': [10, 25, 50, -1]
              }"
            >
              <template v-slot:item="{ item, columns }">
                <tr>
                  <td v-for="column in columns" :key="column.key" :class="`text-${column.align}`">
                    <div v-if="column.key.startsWith('evals.')">
                      <div v-if="item.evals[column.key.split('.')[1]]" class="text-center">
                        <div class="text-caption">{{ item.evals[column.key.split('.')[1]].date }}</div>
                        <v-chip size="small" class="font-weight-bold">{{ item.evals[column.key.split('.')[1]].result }}</v-chip>
                      </div>
                      <div v-else class="text-center text-grey">N/A</div>
                    </div>
                     <div v-else>
                      {{ column.value ? column.value(item) : item[column.key] }}
                    </div>
                  </td>
                </tr>
              </template>
            </v-data-table>
          </v-card-text>
        </v-card>
      </v-container>
    </v-main>
  </v-app>
</template>
