export type SeedCategory = {
  name: string;
  description: string;
  color?: string;
  icon?: string;
};

/**
 * Built-in personal-finance taxonomy used when the model fails to emit
 * valid create_category action_proposal blocks (common with large lists).
 */
export const DEFAULT_CATEGORY_TAXONOMY: SeedCategory[] = [
  // Income
  { name: 'Salary', description: 'Primary employment income', color: '#16a34a', icon: 'banknote' },
  { name: 'Freelance', description: 'Contract and gig income', color: '#22c55e', icon: 'briefcase' },
  { name: 'Business Income', description: 'Business or side-hustle revenue', color: '#15803d', icon: 'building' },
  { name: 'Investments Income', description: 'Dividends, interest, and capital gains', color: '#84cc16', icon: 'trending-up' },
  { name: 'Other Income', description: 'Refunds, gifts received, miscellaneous income', color: '#65a30d', icon: 'plus-circle' },
  // Housing
  { name: 'Rent', description: 'Monthly rent or lease', color: '#0ea5e9', icon: 'home' },
  { name: 'Mortgage', description: 'Home loan EMI / mortgage payment', color: '#0284c7', icon: 'landmark' },
  { name: 'Home Maintenance', description: 'Repairs, cleaning, and upkeep', color: '#38bdf8', icon: 'wrench' },
  { name: 'Property Tax', description: 'Municipal or property taxes', color: '#0369a1', icon: 'receipt' },
  // Food
  { name: 'Groceries', description: 'Supermarket and household groceries', color: '#f59e0b', icon: 'shopping-cart' },
  { name: 'Dining Out', description: 'Restaurants, cafes, and takeout', color: '#f97316', icon: 'utensils' },
  { name: 'Coffee & Snacks', description: 'Coffee shops and small treats', color: '#d97706', icon: 'coffee' },
  // Transport
  { name: 'Fuel', description: 'Petrol, diesel, or EV charging', color: '#6366f1', icon: 'fuel' },
  { name: 'Public Transit', description: 'Bus, metro, train, and passes', color: '#4f46e5', icon: 'train' },
  { name: 'Ride Hailing', description: 'Cab and bike taxi apps', color: '#818cf8', icon: 'car' },
  { name: 'Vehicle Maintenance', description: 'Service, repairs, parking, and tolls', color: '#4338ca', icon: 'car-front' },
  // Utilities
  { name: 'Electricity', description: 'Power utility bills', color: '#eab308', icon: 'zap' },
  { name: 'Water', description: 'Water utility bills', color: '#06b6d4', icon: 'droplets' },
  { name: 'Internet', description: 'Home broadband and ISP', color: '#14b8a6', icon: 'wifi' },
  { name: 'Mobile Phone', description: 'Mobile plans and top-ups', color: '#0d9488', icon: 'smartphone' },
  { name: 'Gas', description: 'Cooking or heating gas', color: '#f43f5e', icon: 'flame' },
  // Health
  { name: 'Healthcare', description: 'Doctor visits, pharmacy, and medical', color: '#ef4444', icon: 'heart-pulse' },
  { name: 'Fitness', description: 'Gym, sports, and wellness', color: '#fb7185', icon: 'dumbbell' },
  // Shopping & lifestyle
  { name: 'Shopping', description: 'Clothes, electronics, and general retail', color: '#a855f7', icon: 'shopping-bag' },
  { name: 'Personal Care', description: 'Salon, grooming, and toiletries', color: '#c026d3', icon: 'sparkles' },
  { name: 'Entertainment', description: 'Movies, events, hobbies, and leisure', color: '#db2777', icon: 'clapperboard' },
  { name: 'Subscriptions', description: 'Streaming, software, and memberships', color: '#7c3aed', icon: 'repeat' },
  // Travel & education
  { name: 'Travel', description: 'Trips, hotels, and holiday spend', color: '#2563eb', icon: 'plane' },
  { name: 'Education', description: 'Courses, tuition, books, and training', color: '#1d4ed8', icon: 'graduation-cap' },
  // Insurance & debt
  { name: 'Insurance', description: 'Health, life, auto, and home premiums', color: '#64748b', icon: 'shield' },
  { name: 'Loan Payments', description: 'Personal loan, EMI, and debt service', color: '#475569', icon: 'credit-card' },
  // Savings & transfers
  { name: 'Savings', description: 'Transfers into savings goals', color: '#059669', icon: 'piggy-bank' },
  { name: 'Investments', description: 'SIP, brokerage, and investment transfers', color: '#047857', icon: 'line-chart' },
  { name: 'Transfers', description: 'Account-to-account transfers', color: '#334155', icon: 'arrow-left-right' },
  // Misc
  { name: 'Gifts & Donations', description: 'Gifts given and charitable giving', color: '#e11d48', icon: 'gift' },
  { name: 'Fees & Charges', description: 'Bank fees, penalties, and service charges', color: '#991b1b', icon: 'circle-alert' },
  { name: 'Miscellaneous', description: 'Uncategorized or one-off expenses', color: '#78716c', icon: 'ellipsis' },
];

export function wantsCategorySeed(userPrompt: string): boolean {
  const p = String(userPrompt || '').toLowerCase();
  if (!p.trim()) return false;
  if (/\/categories\b/.test(p) || /@categories\b/.test(p)) return true;
  if (
    /review my existing categories\. propose create_category/i.test(userPrompt)
  ) {
    return true;
  }
  return (
    /(create|add|seed|propose|set\s*up|build).{0,60}categor(y|ies)/i.test(p) ||
    /categor(y|ies).{0,60}(create|add|seed|propose|as much|many|complete|taxonomy)/i.test(
      p,
    )
  );
}

export function buildSeedCategoryProposals(
  existingNames: string[],
): Array<{
  action_type: 'create_category';
  title: string;
  summary: string;
  payload: SeedCategory;
}> {
  const taken = new Set(
    existingNames.map((n) => n.trim().toLowerCase()).filter(Boolean),
  );
  return DEFAULT_CATEGORY_TAXONOMY.filter(
    (c) => !taken.has(c.name.trim().toLowerCase()),
  ).map((c) => ({
    action_type: 'create_category' as const,
    title: `Create category: ${c.name}`,
    summary: c.description,
    payload: c,
  }));
}
