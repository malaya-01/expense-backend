import { DEFAULT_CATEGORY_TAXONOMY } from '../ai-advisor/default-category-taxonomy';

export type DefaultCategorySeed = {
  name: string;
  description: string;
  color: string;
  icon: string;
};

/**
 * Basic personal-finance categories seeded for every new user
 * (and backfilled for existing users via migration).
 */
export const DEFAULT_USER_CATEGORIES: DefaultCategorySeed[] =
  DEFAULT_CATEGORY_TAXONOMY.map((c) => ({
    name: c.name,
    description: c.description,
    color: c.color || '#3B82F6',
    icon: c.icon || 'ellipsis',
  }));
