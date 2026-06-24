import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';
import { createVuetify } from 'vuetify';

// Mock ResizeObserver for Vuetify components in JSDOM
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const vuetify = createVuetify();

const mountComponent = () => {
  return mount(App, {
    global: {
      plugins: [vuetify],
    },
  });
};

describe('App.vue', () => {
  it('renders the component', () => {
    const wrapper = mountComponent();
    expect(wrapper.exists()).toBe(true);
  });

  it('should initialize with default empty config structures', () => {
    const wrapper = mountComponent();
    expect(wrapper.vm.config.outputColumns.length).toBe(1);
    expect(wrapper.vm.config.tables.length).toBe(0);
  });
});

describe('Helper: cleanName', () => {
  it('should clean standard names correctly', () => {
    const wrapper = mountComponent();
    const cleanName = wrapper.vm.cleanName;
    expect(cleanName('M. DUPONT Jean Pierre (H)')).toBe('DUPONT JEAN');
    expect(cleanName('Mme. MARTIN Marie-Claude (F)')).toBe('MARTIN MARIE-CLAUDE');
    expect(cleanName('M. DE LA FONTAINE Jean (H)')).toBe('DE LA FONTAINE JEAN');
  });

  it('should handle names with maiden names', () => {
    const wrapper = mountComponent();
    const cleanName = wrapper.vm.cleanName;
    expect(cleanName('Mme. LEFEBVRE Marie Née DUBOIS Claire (F)')).toBe('LEFEBVRE MARIE');
  });

  it('should use fallback for names that do not match the strict regex', () => {
    const wrapper = mountComponent();
    const cleanName = wrapper.vm.cleanName;
    expect(cleanName('DUPONT Jean')).toBe('DUPONT JEAN');
    expect(cleanName('Madame Michu')).toBe('MICHU');
  });
});

describe('Helper: parseDate', () => {
  it('should parse Date objects or return null for invalid inputs', () => {
    const wrapper = mountComponent();
    const parseDate = wrapper.vm.parseDate;
    const now = new Date();
    expect(parseDate(now)).toBe(now);
    expect(parseDate(null)).toBeNull();
    expect(parseDate('')).toBeNull();
  });

  it('should parse dates in French text format correctly', () => {
    const wrapper = mountComponent();
    const parseDate = wrapper.vm.parseDate;
    const date = parseDate('22/06/2026 à 16h56');
    expect(date).toBeInstanceOf(Date);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(5); // 0-indexed, so June is 5
    expect(date.getDate()).toBe(22);
    expect(date.getHours()).toBe(16);
    expect(date.getMinutes()).toBe(56);
  });

  it('should parse basic date formats correctly', () => {
    const wrapper = mountComponent();
    const parseDate = wrapper.vm.parseDate;
    const date = parseDate('15/07/2021');
    expect(date.getFullYear()).toBe(2021);
    expect(date.getMonth()).toBe(6); // July
    expect(date.getDate()).toBe(15);
  });
});

describe('Helper: formatDate', () => {
  it('should format a valid date object correctly', () => {
    const wrapper = mountComponent();
    const formatDate = wrapper.vm.formatDate;
    const date = new Date(2023, 10, 5); // 5th November 2023
    expect(formatDate(date)).toBe('05/11/2023');
  });

  it('should return the input as string if not a Date object', () => {
    const wrapper = mountComponent();
    const formatDate = wrapper.vm.formatDate;
    expect(formatDate('2023-11-05')).toBe('2023-11-05');
  });
});

describe('Data Joining & Execution Engine', () => {
  it('correctly processes, normalizes, joins tables and computes output formulas', async () => {
    const wrapper = mountComponent();

    // Mock uploaded tables data
    wrapper.vm.uploadedTables = [
      {
        id: 't1',
        name: 'residents.xlsx',
        alias: 'residents',
        headers: ['Noms / Prénoms', 'GIR'],
        rows: [
          { 'Noms / Prénoms': 'M. DUPONT Jean (H)', 'GIR': 4 },
          { 'Noms / Prénoms': 'Mme. MARTIN Marie (F)', 'GIR': 2 }
        ]
      },
      {
        id: 't2',
        name: 'evals.xlsx',
        alias: 'evaluations',
        headers: ['Résident', 'Type', 'Résultat'],
        rows: [
          { 'Résident': 'M. DUPONT Jean (H)', 'Type': 'MMSE', 'Résultat': '25' },
          { 'Résident': 'M. DUPONT Jean (H)', 'Type': 'GDS', 'Résultat': '5 / 15' },
          { 'Résident': 'Mme. MARTIN Marie (F)', 'Type': 'MMSE', 'Résultat': '18' }
        ]
      }
    ];

    // Set configuration
    wrapper.vm.config = {
      primaryTableAlias: 'residents',
      tables: [
        { name: 'residents.xlsx', alias: 'residents' },
        { name: 'evals.xlsx', alias: 'evaluations' }
      ],
      tableModifiers: {
        // Standardize keys via mod
        residents: [
          {
            column: 'Noms / Prénoms',
            jsCode: 'return cleanName(value);'
          }
        ],
        evaluations: [
          {
            column: 'Résident',
            jsCode: 'return cleanName(value);'
          }
        ]
      },
      joins: [
        {
          secondaryAlias: 'evaluations',
          secondaryColumn: 'Résident',
          primaryColumn: 'Noms / Prénoms'
        }
      ],
      outputColumns: [
        {
          id: 'col_name',
          title: 'Nom Résident',
          jsCode: 'return row["Noms / Prénoms"];'
        },
        {
          id: 'col_gir',
          title: 'GIR',
          jsCode: 'return row["GIR"];'
        },
        {
          id: 'col_eval_count',
          title: 'Nombre Evals',
          jsCode: 'return evaluations.length;'
        },
        {
          id: 'col_mmse',
          title: 'Score MMSE',
          jsCode: `
            const mmse = evaluations.find(e => e.Type === 'MMSE');
            return mmse ? mmse.Résultat : 'N/A';
          `
        }
      ]
    };

    // Force trigger compilation
    wrapper.vm.triggerCompilation();
    await wrapper.vm.$nextTick();

    const report = wrapper.vm.generatedReportData;
    expect(report.length).toBe(2);

    // Dupont
    expect(report[0].col_name).toBe('DUPONT JEAN');
    expect(report[0].col_gir).toBe(4);
    expect(report[0].col_eval_count).toBe(2);
    expect(report[0].col_mmse).toBe('25');

    // Martin
    expect(report[1].col_name).toBe('MARTIN MARIE');
    expect(report[1].col_gir).toBe(2);
    expect(report[1].col_eval_count).toBe(1);
    expect(report[1].col_mmse).toBe('18');
  });

  it('safely catches evaluation script errors and reports them in cells', async () => {
    const wrapper = mountComponent();
    wrapper.vm.uploadedTables = [
      {
        id: 't1',
        name: 'test.xlsx',
        alias: 'test',
        headers: ['Val'],
        rows: [{ 'Val': 10 }]
      }
    ];

    wrapper.vm.config = {
      primaryTableAlias: 'test',
      tables: [{ name: 'test.xlsx', alias: 'test' }],
      tableModifiers: {},
      joins: [],
      outputColumns: [
        {
          id: 'col_err',
          title: 'Error Col',
          jsCode: 'throw new Error("Erreur de test");'
        }
      ]
    };

    wrapper.vm.triggerCompilation();
    await wrapper.vm.$nextTick();

    const report = wrapper.vm.generatedReportData;
    expect(report[0].col_err).toContain('[Erreur: Erreur de test]');
  });
});
