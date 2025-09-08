import { describe, it, expect, test, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import App from './App.vue';
import * as XLSX from 'xlsx';

describe('App.vue', () => {
  it('renders the component', () => {
    const wrapper = mount(App);
    expect(wrapper.exists()).toBe(true);
  });

  it('should have the output section hidden initially', () => {
    const wrapper = mount(App);
    expect(wrapper.find('.output-section').exists()).toBe(false);
  });

  it('should have the generate button disabled initially', () => {
    const wrapper = mount(App);
    expect(wrapper.find('button.bg-blue-600').attributes('disabled')).toBeDefined();
  });

  it('should show an error message if generate is clicked without files', async () => {
    const wrapper = mount(App);
    wrapper.vm.residentsDataCache = null;
    wrapper.vm.evaluationsDataCache = null;
    await wrapper.vm.$nextTick();

    await wrapper.vm.generateReport();
    expect(wrapper.vm.errorMessage).toBe('Veuillez charger les deux fichiers valides.');
  });
});

describe('formatDate', () => {
    const wrapper = mount(App);
    const formatDate = wrapper.vm.formatDate;

    it('should format a valid date object correctly', () => {
        const date = new Date(2023, 10, 5); // 5th November 2023
        expect(formatDate(date)).toBe('05/11/2023');
    });

    it('should handle single-digit day and month', () => {
        const date = new Date(2023, 0, 1); // 1st January 2023
        expect(formatDate(date)).toBe('01/01/2023');
    });

    it('should return an empty string for null or undefined input', () => {
        expect(formatDate(null)).toBe('');
        expect(formatDate(undefined)).toBe('');
    });

    it('should return the original value if it is not a Date object', () => {
        expect(formatDate('2023-11-05')).toBe('2023-11-05');
        expect(formatDate(12345)).toBe(12345);
    });
});

describe('processFile', () => {
    const wrapper = mount(App);
    const processFile = wrapper.vm.processFile;

    it('should process a .xlsx file correctly', async () => {
        const data = [{ a: 1 }, { a: 2 }];
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
        const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
        const file = new File([buffer], 'test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

        const result = await processFile(file);
        expect(result).toEqual(data);
    });

    it('should process a .csv file correctly', async () => {
        const csv = `"col1","col2"\\n"val1","val2"`;
        const file = new File([csv], 'test.csv', { type: 'text/csv' });
        const result = await processFile(file);
        expect(result).toEqual([{ col1: 'val1', col2: 'val2' }]);
    });

    it('should reject with an error if file reading fails', async () => {
        const file = new File([], 'test.txt', { type: 'text/plain' });
        // Mock FileReader to simulate an error
        const reader = new FileReader();
        vi.spyOn(window, 'FileReader').mockImplementation(() => reader);
        setTimeout(() => reader.onerror(new Error('Test Error')), 0);
        await expect(processFile(file)).rejects.toThrow('Test Error');
    });
});

describe('generateReport', () => {
    it('should correctly process and merge resident and evaluation data', async () => {
        const wrapper = mount(App);

        const residentsData = [
            { 'Résident': 'M. DUPONT Jean (H)', 'N° de chambre': '101', 'Âge': 60, 'Date naissance': new Date('1963-01-01'), 'Dernière entrée': new Date('2023-01-01'), 'GIR': '4' },
        ];
        const evaluationsData = [
            { 'Résident': 'M. DUPONT Jean (H)', 'Date': '01/01/2023 à 10:00', 'Type': 'MMSE', 'Résultat': '25' },
            { 'Résident': 'M. DUPONT Jean (H)', 'Date': '02/01/2023 à 10:00', 'Type': 'GDS', 'Résultat': '5 / 30' },
        ];

        wrapper.vm.residentsDataCache = residentsData;
        wrapper.vm.evaluationsDataCache = evaluationsData;
        await wrapper.vm.$nextTick();

        await wrapper.vm.generateReport();

        expect(wrapper.vm.processedData.length).toBe(1);
        const resident = wrapper.vm.processedData[0];
        expect(resident['N° de chambre']).toBe('101');
        expect(resident.evals.MMSE.result).toBe('25');
        expect(resident.evals.GDS.result).toBe('5');
    });
});

describe('normalizeName', () => {
    const wrapper = mount(App);
    const normalizeName = wrapper.vm.normalizeName;

    test('should return an empty string for empty or invalid input', () => {
        expect(normalizeName('')).toBe('');
        expect(normalizeName('   ')).toBe('');
        expect(normalizeName(null)).toBe('');
        expect(normalizeName(undefined)).toBe('');
    });

    test('should handle simple names correctly', () => {
        expect(normalizeName('M. DUPONT Jean (H)')).toBe('DUPONT Jean');
        expect(normalizeName('Mme. DURAND Marie (F)')).toBe('DURAND Marie');
    });

    test('should handle names with multiple parts', () => {
        expect(normalizeName('M. DE LA FONTAINE Jean (H)')).toBe('DE LA FONTAINE Jean');
        expect(normalizeName('Mme. MARTIN-DUPONT Anne-Marie (F)')).toBe('MARTIN-DUPONT Anne-Marie');
    });

    test('should handle names with maiden names', () => {
        expect(normalizeName('Mme. LEFEBVRE Marie Née DUBOIS Claire (F)')).toBe('LEFEBVRE Marie DUBOIS Claire');
    });

    test('should handle names with NIR numbers', () => {
        expect(normalizeName('M. PETIT Pierre (H) 123456789012345 [NIR]')).toBe('PETIT Pierre');
    });

    test('should handle names with extra spaces and line breaks', () => {
        expect(normalizeName('  M.    MARTIN   Paul   (H)  ')).toBe('MARTIN Paul');
        expect(normalizeName(`Mme.
 LEROUX
 Chloé
 (F)`)).toBe('LEROUX Chloé');
    });

    test('should handle names with quotes', () => {
        expect(normalizeName('"M. GARCIA José (H)"')).toBe('GARCIA José');
    });

    test('should use fallback for non-matching names', () => {
        expect(normalizeName('DUPONT Jean')).toBe('DUPONT Jean');
        expect(normalizeName('Madame Michu')).toBe('Michu');
    });
});
