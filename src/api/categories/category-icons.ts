/**
 * Canonical category icon ids stored in `categories.icon`.
 * Keep in sync with frontend `lib/categories/icons.ts`.
 */
export const CATEGORY_ICON_IDS = [
  // Money & finance
  'banknote',
  'circle-dollar-sign',
  'coins',
  'hand-coins',
  'badge-dollar-sign',
  'credit-card',
  'wallet',
  'piggy-bank',
  'landmark',
  'scale',
  'chart-pie',
  'chart-bar',
  'line-chart',
  'trending-up',
  'trending-down',
  'activity',
  // Work & income
  'briefcase',
  'building',
  'building-2',
  'factory',
  'warehouse',
  'handshake',
  'users',
  'user',
  'plus-circle',
  // Home & living
  'home',
  'bed',
  'bath',
  'sofa',
  'lamp',
  'key',
  'key-round',
  'wrench',
  'hammer',
  'paintbrush',
  'brush',
  'plug',
  'zap',
  'droplets',
  'flame',
  'wifi',
  'smartphone',
  'monitor',
  'laptop',
  'tablet',
  'tv',
  'printer',
  'hard-drive',
  'cloud',
  'database',
  // Food & drink
  'shopping-cart',
  'shopping-bag',
  'store',
  'utensils',
  'coffee',
  'pizza',
  'cake',
  'cookie',
  'croissant',
  'fish',
  'ice-cream-cone',
  'salad',
  'soup',
  'wine',
  'beer',
  'apple',
  // Transport & travel
  'car',
  'car-front',
  'bus',
  'train',
  'bike',
  'fuel',
  'plane',
  'ship',
  'sailboat',
  'anchor',
  'rocket',
  'map-pin',
  'map',
  'compass',
  'globe',
  'hotel',
  'palmtree',
  'mountain',
  'umbrella',
  'sun',
  'ticket',
  // Health & personal
  'heart',
  'heart-pulse',
  'stethoscope',
  'hospital',
  'pill',
  'syringe',
  'thermometer',
  'ambulance',
  'dumbbell',
  'bone',
  'smile',
  'glasses',
  'watch',
  'sparkles',
  'scissors',
  // Education & media
  'graduation-cap',
  'school',
  'university',
  'library',
  'book',
  'book-open',
  'newspaper',
  'pen-line',
  'pencil',
  'calculator',
  'microscope',
  'flask-conical',
  'atom',
  'cpu',
  'bot',
  'code',
  'terminal',
  // Fun & lifestyle
  'gift',
  'party-popper',
  'crown',
  'gem',
  'star',
  'trophy',
  'medal',
  'target',
  'gamepad-2',
  'dice-5',
  'clapperboard',
  'film',
  'popcorn',
  'music',
  'guitar',
  'headphones',
  'mic',
  'speaker',
  'camera',
  'image',
  'palette',
  'repeat',
  // Pets & nature
  'paw-print',
  'cat',
  'dog',
  'bird',
  'leaf',
  'flower-2',
  'sprout',
  'tree-pine',
  'recycle',
  // Shopping & misc
  'package',
  'shirt',
  'footprints',
  'receipt',
  'circle-alert',
  'bell',
  'calendar',
  'clock',
  'timer',
  'mail',
  'phone',
  'lock',
  'shield',
  'gavel',
  'file-text',
  'folder',
  'clipboard-list',
  'tags',
  'ellipsis',
  'arrow-left-right',
  'baby',
  'cigarette',
  'trash-2',
] as const;

export type CategoryIconId = (typeof CATEGORY_ICON_IDS)[number];

export const CATEGORY_ICON_SET = new Set<string>(CATEGORY_ICON_IDS);

export function isCategoryIconId(
  value: string | null | undefined,
): value is CategoryIconId {
  return Boolean(value && CATEGORY_ICON_SET.has(value));
}

export function normalizeCategoryIcon(
  icon: string | null | undefined,
  fallback: CategoryIconId = 'tags',
): CategoryIconId {
  const key = String(icon || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  // lucide aliases
  if (key === 'ice-cream') return isCategoryIconId('ice-cream-cone')
    ? 'ice-cream-cone'
    : fallback;
  if (key === 'building2') return 'building-2';
  return isCategoryIconId(key) ? key : fallback;
}

/** Rule-based icon from category name/description (no AI). */
export function suggestCategoryIconHeuristic(
  name: string,
  description = '',
): CategoryIconId {
  const text = `${name} ${description}`.toLowerCase();

  const rules: Array<[RegExp, CategoryIconId]> = [
    [/salary|payroll|wage|paycheck/, 'banknote'],
    [/freelance|contract|gig|consult/, 'briefcase'],
    [/business|company|revenue|startup/, 'building-2'],
    [/factory|manufactur/, 'factory'],
    [/warehouse|storage|inventory/, 'warehouse'],
    [/dividend|capital gain|broker|sip|mutual fund|stock|equity/, 'line-chart'],
    [/invest|portfolio|crypto|bitcoin/, 'trending-up'],
    [/rent|lease|housing|apartment/, 'home'],
    [/mortgage|home loan/, 'landmark'],
    [/repair|maintenance|upkeep|fix/, 'wrench'],
    [/paint|renovat|decor/, 'paintbrush'],
    [/furniture|sofa|couch/, 'sofa'],
    [/bed|bedroom|sleep/, 'bed'],
    [/bath|plumbing/, 'bath'],
    [/tax|gst|property tax/, 'receipt'],
    [/grocer|supermarket|kirana|market|provisions/, 'shopping-cart'],
    [/dining|restaurant|food|takeout|cafe|meal|lunch|dinner/, 'utensils'],
    [/coffee|tea|snack|chai/, 'coffee'],
    [/pizza/, 'pizza'],
    [/cake|bakery|dessert/, 'cake'],
    [/beer|alcohol|bar|pub/, 'beer'],
    [/wine/, 'wine'],
    [/fuel|petrol|diesel|ev charg|gas station/, 'fuel'],
    [/transit|metro|bus|train|commute/, 'train'],
    [/uber|ola|cab|taxi|ride hail/, 'car'],
    [/bike|scooter|two.?wheel/, 'bike'],
    [/vehicle|parking|toll|car service|auto/, 'car-front'],
    [/flight|airfare|airport/, 'plane'],
    [/hotel|staycation|lodging/, 'hotel'],
    [/travel|holiday|vacation|trip|tour/, 'palmtree'],
    [/electric|power|electricity bill/, 'zap'],
    [/\bwater\b|water bill/, 'droplets'],
    [/internet|broadband|wifi|isp|fiber/, 'wifi'],
    [/mobile|phone|prepaid|recharge|sim/, 'smartphone'],
    [/\bgas\b|lpg|cylinder|cooking gas/, 'flame'],
    [/health|medical|pharmacy|doctor|clinic|dental/, 'heart-pulse'],
    [/hospital|emergency/, 'hospital'],
    [/fitness|gym|sport|yoga|workout/, 'dumbbell'],
    [/pet|dog|cat|vet/, 'paw-print'],
    [/shop|retail|clothes|apparel|fashion|electronics/, 'shopping-bag'],
    [/personal care|salon|groom|spa|beauty/, 'sparkles'],
    [/entertain|movie|cinema|hobby|leisure|netflix|spotify/, 'clapperboard'],
    [/game|gaming|playstation|xbox/, 'gamepad-2'],
    [/music|concert/, 'music'],
    [/subscription|streaming|membership|saas/, 'repeat'],
    [/educat|tuition|course|school|college|university|learning/, 'graduation-cap'],
    [/book|library|reading/, 'book-open'],
    [/insur|premium|policy/, 'shield'],
    [/loan|emi|debt|credit card bill/, 'credit-card'],
    [/sav|emergency fund|fd|deposit/, 'piggy-bank'],
    [/transfer|p2p|upi send/, 'arrow-left-right'],
    [/gift|donat|charit|zakat/, 'gift'],
    [/fee|charge|penalty|bank fee|late fee/, 'circle-alert'],
    [/wallet|cash|atm/, 'wallet'],
    [/child|baby|kids|daycare/, 'baby'],
    [/party|celebration|wedding/, 'party-popper'],
    [/utility|bill pay/, 'receipt'],
    [/software|cloud|hosting|domain/, 'cloud'],
    [/office|stationery/, 'pen-line'],
    [/misc|other|general|sundry|uncategor/, 'ellipsis'],
  ];

  for (const [pattern, icon] of rules) {
    if (pattern.test(text)) return icon;
  }

  // Light keyword hits on single tokens in the name
  const token = name.trim().toLowerCase();
  for (const [pattern, icon] of rules) {
    if (pattern.test(token)) return icon;
  }
  return 'tags';
}
