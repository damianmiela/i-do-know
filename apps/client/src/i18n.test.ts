import { describe, expect, it } from 'vitest';
import { detectLang, formatNumber, t } from './i18n';

describe('t', () => {
  it('fills in placeholders and formats numbers per language', () => {
    expect(t('en', 'questionOf', { n: 5, total: 15 })).toBe('Question 5 of 15');
    expect(t('en', 'langTitle', { name: 'Łukasz' })).toBe('Hi Łukasz! Pick your language');
    expect(t('en', 'pointsTotal', { n: 4210 })).toBe('4,210 points in total');
    expect(t('de', 'pointsTotal', { n: 4210 })).toBe('4.210 Punkte insgesamt');
    expect(t('pl', 'pointsTotal', { n: 4210 })).toBe('Razem 4210 pkt'); // Polish: no space below 10 000
    expect(t('pl', 'pointsTotal', { n: 12345 })).toMatch(/^Razem 12\s345 pkt$/);
  });

  it('picks plural forms, including Polish few/many', () => {
    expect(t('en', 'places', { n: 1 })).toBe('1 place');
    expect(t('en', 'places', { n: 3 })).toBe('3 places');
    expect(t('pl', 'places', { n: 1 })).toBe('1 miejsce');
    expect(t('pl', 'places', { n: 3 })).toBe('3 miejsca');
    expect(t('pl', 'places', { n: 5 })).toBe('5 miejsc');
    expect(t('pl', 'places', { n: 22 })).toBe('22 miejsca');
    expect(t('de', 'places', { n: 2 })).toBe('2 Plätze');
  });

  it('leaves unknown placeholders visible instead of failing', () => {
    expect(t('en', 'questionOf', { n: 1 })).toBe('Question 1 of {total}');
  });
});

describe('numbers', () => {
  it('formats decimals per language', () => {
    expect(formatNumber('en', 5.14, 1)).toBe('5.1');
    expect(formatNumber('pl', 5.14, 1)).toBe('5,1');
  });
});

describe('detectLang', () => {
  it("uses the phone's first supported language", () => {
    expect(detectLang(['ca-ES', 'es-ES'])).toBe('ca');
    expect(detectLang(['fr-FR', 'de-AT'])).toBe('de');
    expect(detectLang(['pl'])).toBe('pl');
    expect(detectLang(['fr', 'it'])).toBe('en');
    expect(detectLang([])).toBe('en');
  });
});
