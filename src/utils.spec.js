
import { describe, it, expect } from 'vitest';
import { cleanDisplayName, naturalSort } from './utils';

describe('cleanDisplayName', () => {
  it('should remove (H) and (F)', () => {
    expect(cleanDisplayName('Dupont Jean (H)')).toBe('Dupont Jean');
    expect(cleanDisplayName('Martin Marie (F)')).toBe('Martin Marie');
    expect(cleanDisplayName('Dupont Jean(H)')).toBe('Dupont Jean'); // tight
    expect(cleanDisplayName('Dupont Jean (h)')).toBe('Dupont Jean');
  });

  it('should remove part after Née', () => {
    expect(cleanDisplayName('Martin Marie Née Durand')).toBe('Martin Marie');
    expect(cleanDisplayName('Martin Marie née Durand')).toBe('Martin Marie');
    expect(cleanDisplayName('Martin Marie Née Durand (F)')).toBe('Martin Marie');
    expect(cleanDisplayName('Renée Martin')).toBe('Renée Martin'); // Should not cut Renée
  });

  it('should handle both', () => {
    expect(cleanDisplayName('Martin Marie Née Durand (F)')).toBe('Martin Marie');
  });
});

describe('naturalSort', () => {
  it('should sort room numbers correctly', () => {
    const rooms = ['10', '1', '2', '100', '20', '10A', '10B'];
    const sorted = rooms.sort(naturalSort);
    expect(sorted).toEqual(['1', '2', '10', '10A', '10B', '20', '100']);
  });
});
