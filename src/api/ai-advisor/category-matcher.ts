/**
 * Pick one of the USER's existing categories from merchant / description
 * semantics. Never fabricates: every return value is an element of the
 * supplied list. Pure (no Nest / DB imports).
 */

export type CategoryLike = {
  id: string;
  name: string;
  parent_id?: string | null;
};

type Rule = {
  /** Default-taxonomy names (default-category-taxonomy.ts) this rule maps to. */
  names: string[];
  /** Words that identify a user's own variant of the category name. */
  aliases: string[];
  keywords: RegExp;
  kind?: 'expense' | 'income';
};

// Ordered specific → generic (coffee before dining, ride hailing before travel).
const RULES: Rule[] = [
  {
    names: ['Salary'],
    aliases: ['salary', 'payroll', 'wages'],
    keywords: /\b(salary|payroll|wages|paycheck|stipend)\b/,
    kind: 'income',
  },
  {
    names: ['Freelance'],
    aliases: ['freelance', 'consulting'],
    keywords: /\b(freelance|consulting|invoice paid|client payment|upwork|fiverr)\b/,
    kind: 'income',
  },
  {
    names: ['Investments Income'],
    aliases: ['dividend', 'interest', 'investment income'],
    keywords: /\b(dividend|interest (?:credited|received|earned)|fd interest|savings interest)\b/,
    kind: 'income',
  },
  {
    names: ['Other Income'],
    aliases: ['other income', 'refund', 'cashback'],
    keywords: /\b(refund|cashback|cash back|reimburse(?:ment|d)?|reward|gift received)\b/,
    kind: 'income',
  },
  {
    names: ['Coffee & Snacks'],
    aliases: ['coffee', 'snack', 'cafe'],
    keywords: /\b(coffee|starbucks|ccd|cafe coffee day|blue tokai|third wave|chai|tea|snacks?|bakery|cafe)\b/,
  },
  {
    names: ['Groceries'],
    aliases: ['grocer', 'supermarket'],
    keywords: /\b(grocer(?:y|ies)|supermarket|hypermarket|d ?mart|avenue supermarts|bigbasket|big basket|blinkit|zepto|instamart|jiomart|reliance (?:fresh|smart)|more retail|spencer'?s|nature'?s basket|kirana|vegetables?|fruits?|milk|dairy|walmart|costco|tesco|aldi|kroger|whole foods|lidl|sainsbury'?s)\b/,
  },
  {
    names: ['Dining Out'],
    aliases: ['dining', 'restaurant', 'eating out', 'food'],
    keywords: /\b(restaurant|dine|dining|dinner|lunch|breakfast|brunch|swiggy|zomato|eatsure|food court|pizza|burger|kfc|mcdonald'?s|domino'?s|subway|biryani|dhaba|barbeque|bbq|pub|bar|bistro|takeaway|takeout|doordash|ubereats|uber eats|grubhub|deliveroo)\b/,
  },
  {
    names: ['Ride Hailing'],
    aliases: ['ride', 'cab', 'taxi'],
    keywords: /\b(uber|ola|rapido|lyft|cab|taxi|auto ?rickshaw|bluSmart|blusmart|bike taxi)\b/,
  },
  {
    names: ['Fuel'],
    aliases: ['fuel', 'petrol'],
    keywords: /\b(fuel|petrol|diesel|cng|indian oil|iocl|hpcl|bpcl|bharat petroleum|hindustan petroleum|shell|nayara|gas station|filling station|ev charging)\b/,
  },
  {
    names: ['Public Transit'],
    aliases: ['transit', 'metro', 'transport'],
    keywords: /\b(metro|bus|train|irctc|railways?|local train|transit|subway card|oyster)\b/,
  },
  {
    names: ['Vehicle Maintenance'],
    aliases: ['vehicle', 'car', 'parking'],
    keywords: /\b(parking|toll|fastag|car wash|service cent(?:er|re)|tyres?|tires?|vehicle service|bike service|car service)\b/,
  },
  {
    names: ['Electricity'],
    aliases: ['electric', 'power'],
    keywords: /\b(electricity|power bill|bescom|tneb|tangedco|msedcl|mahadiscom|tata power|adani electricity|bses|cesc|discom|electric bill)\b/,
  },
  {
    names: ['Water'],
    aliases: ['water'],
    keywords: /\b(water bill|water board|jal board|bwssb)\b/,
  },
  {
    names: ['Internet'],
    aliases: ['internet', 'broadband', 'wifi'],
    keywords: /\b(broadband|internet|wi-?fi|fiber|fibre|jiofiber|airtel xstream|act fibernet|hathway)\b/,
  },
  {
    names: ['Mobile Phone'],
    aliases: ['mobile', 'phone', 'recharge'],
    keywords: /\b(recharge|prepaid|postpaid|mobile bill|phone bill|jio|airtel|vodafone|vi recharge|bsnl)\b/,
  },
  {
    names: ['Gas'],
    aliases: ['gas', 'lpg'],
    keywords: /\b(lpg|gas cylinder|cylinder|indane|hp gas|bharat gas|piped gas|mahanagar gas|igl|gas bill)\b/,
  },
  {
    names: ['Healthcare'],
    aliases: ['health', 'medical', 'pharmacy'],
    keywords: /\b(pharmacy|chemist|medical|medicines?|apollo|hospital|clinic|doctor|diagnostic|pathology|lab test|1mg|pharmeasy|netmeds|medplus|dental|dentist)\b/,
  },
  {
    names: ['Fitness'],
    aliases: ['fitness', 'gym'],
    keywords: /\b(gym|fitness|cult\.?fit|yoga|crossfit|sports club)\b/,
  },
  {
    names: ['Subscriptions'],
    aliases: ['subscription', 'streaming'],
    keywords: /\b(netflix|spotify|prime video|amazon prime|hotstar|jiocinema|youtube premium|apple music|icloud|google one|chatgpt|subscription|disney\+?)\b/,
  },
  {
    names: ['Entertainment'],
    aliases: ['entertainment', 'movies', 'leisure'],
    keywords: /\b(movie|cinema|pvr|inox|bookmyshow|concert|gaming|steam|playstation|amusement|theme park)\b/,
  },
  {
    names: ['Personal Care'],
    aliases: ['personal care', 'salon', 'grooming'],
    keywords: /\b(salon|spa|haircut|barber|grooming|parlou?r|nykaa|cosmetics)\b/,
  },
  {
    names: ['Travel'],
    aliases: ['travel', 'trip', 'vacation'],
    keywords: /\b(flight|airlines?|indigo|air india|vistara|akasa|spicejet|makemytrip|goibibo|cleartrip|airbnb|oyo|booking\.com|hotel booking|resort|holiday)\b/,
  },
  {
    names: ['Education'],
    aliases: ['education', 'tuition', 'school'],
    keywords: /\b(tuition|school fees?|college fees?|course|udemy|coursera|byju'?s|unacademy|books?|exam fees?)\b/,
  },
  {
    names: ['Insurance'],
    aliases: ['insurance'],
    keywords: /\b(insurance|premium|lic|policy renewal)\b/,
  },
  {
    names: ['Rent'],
    aliases: ['rent', 'lease'],
    keywords: /\b(rent|lease|landlord)\b/,
  },
  {
    names: ['Loan Payments'],
    aliases: ['loan', 'emi', 'debt'],
    keywords: /\b(emi|loan repayment|loan payment)\b/,
  },
  {
    names: ['Gifts & Donations'],
    aliases: ['gift', 'donation', 'charity'],
    keywords: /\b(donation|donated|charity|gift|temple|church|mosque|gurudwara|ngo)\b/,
  },
  {
    names: ['Fees & Charges'],
    aliases: ['fee', 'charge'],
    keywords: /\b(bank charges?|late fee|annual fee|penalty|service charge|processing fee|convenience fee|gst on charges)\b/,
  },
  {
    names: ['Shopping'],
    aliases: ['shopping', 'retail', 'clothing'],
    keywords: /\b(amazon|flipkart|myntra|ajio|meesho|nykaa fashion|mall|clothing|clothes|apparel|shoes|electronics|croma|reliance digital|decathlon|ikea|zara|h&m|uniqlo|westside|lifestyle|shoppers stop)\b/,
  },
];

const FALLBACK_EXPENSE = ['miscellaneous', 'misc', 'other', 'others', 'general', 'uncategorized', 'other expenses'];
const FALLBACK_INCOME = ['other income', 'income', 'miscellaneous income'];

export function normalizeCategoryName(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\b(\w{3,})s\b/g, '$1');
}

/** Exact (normalised) → hierarchical ("Food > Dining") → containment. */
export function findCategoryByName<T extends CategoryLike>(
  categories: T[],
  name: unknown,
): T | null {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  const segments = raw
    .split(/\s*(?:>|\/|:|›|»|→)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tries = [raw, ...segments.reverse()];
  for (const attempt of tries) {
    const wanted = normalizeCategoryName(attempt);
    if (!wanted) continue;
    const exact = categories.find((c) => normalizeCategoryName(c.name) === wanted);
    if (exact) return exact;
  }
  const wanted = normalizeCategoryName(segments[0] || raw);
  if (wanted.length >= 4) {
    const partial = categories.filter((c) => {
      const have = normalizeCategoryName(c.name);
      return have.length >= 4 && (have.includes(wanted) || wanted.includes(have));
    });
    if (partial.length === 1) return partial[0];
  }
  return null;
}

function findByAliases<T extends CategoryLike>(categories: T[], aliases: string[]): T | null {
  for (const alias of aliases) {
    const a = normalizeCategoryName(alias);
    const hit = categories.find((c) => ` ${normalizeCategoryName(c.name)} `.includes(` ${a}`));
    if (hit) return hit;
  }
  return null;
}

/** Best existing category for a merchant / description, or null. */
export function suggestCategoryFromText<T extends CategoryLike>(
  categories: T[],
  text: unknown,
  type: 'expense' | 'income' | 'transfer' | string = 'expense',
): T | null {
  if (type === 'transfer') return null;
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim() || !categories.length) return null;

  // A user category whose own name appears in the text wins outright.
  const named = [...categories]
    .filter((c) => normalizeCategoryName(c.name).length >= 4)
    .sort((a, b) => b.name.length - a.name.length)
    .find((c) => {
      const escaped = c.name.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(hay);
    });
  if (named) return named;

  for (const rule of RULES) {
    if (rule.kind && rule.kind !== type) continue;
    if (!rule.kind && type === 'income') continue;
    if (!rule.keywords.test(hay)) continue;
    for (const name of rule.names) {
      const exact = findCategoryByName(categories, name);
      if (exact) return exact;
    }
    const alias = findByAliases(categories, rule.aliases);
    if (alias) return alias;
  }
  return null;
}

/** "Miscellaneous" / "Other" (or "Other Income") when nothing fits. */
export function fallbackCategory<T extends CategoryLike>(
  categories: T[],
  type: 'expense' | 'income' | string = 'expense',
): T | null {
  const wanted = type === 'income' ? FALLBACK_INCOME : FALLBACK_EXPENSE;
  for (const name of wanted) {
    const hit = categories.find(
      (c) => normalizeCategoryName(c.name) === normalizeCategoryName(name),
    );
    if (hit) return hit;
  }
  return null;
}
