/** Approximate units of each currency per 1 USD (static seed; override on tx). */
export const UNITS_PER_USD: Record<string, number> = {
  USD: 1,
  EUR: 0.92,
  GBP: 0.79,
  INR: 83.5,
  AED: 3.67,
  SAR: 3.75,
  SGD: 1.34,
  AUD: 1.52,
  CAD: 1.36,
  JPY: 151.2,
  CNY: 7.24,
  HKD: 7.82,
  CHF: 0.88,
  NZD: 1.64,
  SEK: 10.4,
  NOK: 10.6,
  DKK: 6.87,
  ZAR: 18.5,
  BRL: 5.05,
  MXN: 17.1,
  PHP: 56.5,
  THB: 35.2,
  MYR: 4.7,
  IDR: 15800,
  PKR: 278,
  BDT: 110,
  LKR: 305,
  NPR: 133,
  KRW: 1350,
  TRY: 32.5,
  RUB: 92,
  PLN: 3.95,
  CZK: 22.8,
  HUF: 355,
  ILS: 3.7,
  EGP: 48.5,
  NGN: 1550,
  KES: 129,
  GHS: 15.2,
  VND: 25400,
};

export type CountryOption = {
  code: string;
  name: string;
  currency: string;
};

export const COUNTRIES: CountryOption[] = [
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'AE', name: 'United Arab Emirates', currency: 'AED' },
  { code: 'SA', name: 'Saudi Arabia', currency: 'SAR' },
  { code: 'SG', name: 'Singapore', currency: 'SGD' },
  { code: 'AU', name: 'Australia', currency: 'AUD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
  { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'NL', name: 'Netherlands', currency: 'EUR' },
  { code: 'IE', name: 'Ireland', currency: 'EUR' },
  { code: 'ES', name: 'Spain', currency: 'EUR' },
  { code: 'IT', name: 'Italy', currency: 'EUR' },
  { code: 'JP', name: 'Japan', currency: 'JPY' },
  { code: 'CN', name: 'China', currency: 'CNY' },
  { code: 'HK', name: 'Hong Kong', currency: 'HKD' },
  { code: 'CH', name: 'Switzerland', currency: 'CHF' },
  { code: 'NZ', name: 'New Zealand', currency: 'NZD' },
  { code: 'SE', name: 'Sweden', currency: 'SEK' },
  { code: 'NO', name: 'Norway', currency: 'NOK' },
  { code: 'DK', name: 'Denmark', currency: 'DKK' },
  { code: 'ZA', name: 'South Africa', currency: 'ZAR' },
  { code: 'BR', name: 'Brazil', currency: 'BRL' },
  { code: 'MX', name: 'Mexico', currency: 'MXN' },
  { code: 'PH', name: 'Philippines', currency: 'PHP' },
  { code: 'TH', name: 'Thailand', currency: 'THB' },
  { code: 'MY', name: 'Malaysia', currency: 'MYR' },
  { code: 'ID', name: 'Indonesia', currency: 'IDR' },
  { code: 'PK', name: 'Pakistan', currency: 'PKR' },
  { code: 'BD', name: 'Bangladesh', currency: 'BDT' },
  { code: 'LK', name: 'Sri Lanka', currency: 'LKR' },
  { code: 'NP', name: 'Nepal', currency: 'NPR' },
  { code: 'KR', name: 'South Korea', currency: 'KRW' },
  { code: 'TR', name: 'Turkey', currency: 'TRY' },
  { code: 'PL', name: 'Poland', currency: 'PLN' },
  { code: 'CZ', name: 'Czechia', currency: 'CZK' },
  { code: 'HU', name: 'Hungary', currency: 'HUF' },
  { code: 'IL', name: 'Israel', currency: 'ILS' },
  { code: 'EG', name: 'Egypt', currency: 'EGP' },
  { code: 'NG', name: 'Nigeria', currency: 'NGN' },
  { code: 'KE', name: 'Kenya', currency: 'KES' },
  { code: 'GH', name: 'Ghana', currency: 'GHS' },
  { code: 'VN', name: 'Vietnam', currency: 'VND' },
];

export const SUPPORTED_CURRENCIES = Object.keys(UNITS_PER_USD).sort();

export function isSupportedCurrency(code: string): boolean {
  return Boolean(UNITS_PER_USD[code?.toUpperCase()]);
}

export function getCountry(code: string): CountryOption | undefined {
  return COUNTRIES.find((c) => c.code === code.toUpperCase());
}

/** Convert amount from one currency to another using USD pivot rates. */
export function convertAmount(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  overrideRate?: number,
): number {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) return roundMoney(amount);
  if (overrideRate !== undefined && overrideRate > 0) {
    return roundMoney(amount * overrideRate);
  }
  const fromPerUsd = UNITS_PER_USD[from];
  const toPerUsd = UNITS_PER_USD[to];
  if (!fromPerUsd || !toPerUsd) {
    throw new Error(`Unsupported currency pair: ${from} → ${to}`);
  }
  return roundMoney((amount / fromPerUsd) * toPerUsd);
}

/** How many units of `to` equal 1 unit of `from`. */
export function getRate(fromCurrency: string, toCurrency: string): number {
  const from = fromCurrency.toUpperCase();
  const to = toCurrency.toUpperCase();
  if (from === to) return 1;
  const fromPerUsd = UNITS_PER_USD[from];
  const toPerUsd = UNITS_PER_USD[to];
  if (!fromPerUsd || !toPerUsd) {
    throw new Error(`Unsupported currency pair: ${from} → ${to}`);
  }
  return toPerUsd / fromPerUsd;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
