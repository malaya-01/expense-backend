-- Up Migration
-- Seed built-in personal-finance categories for every existing user.
-- New signups get the same set via CategoriesService.seedDefaultsForUser.

INSERT INTO categories (user_id, name, description, color, icon, is_system)
SELECT u.id, v.name, v.description, v.color, v.icon, TRUE
FROM users u
CROSS JOIN (
  VALUES
    ('Salary', 'Primary employment income', '#16a34a', 'banknote'),
    ('Freelance', 'Contract and gig income', '#22c55e', 'briefcase'),
    ('Business Income', 'Business or side-hustle revenue', '#15803d', 'building'),
    ('Investments Income', 'Dividends, interest, and capital gains', '#84cc16', 'trending-up'),
    ('Other Income', 'Refunds, gifts received, miscellaneous income', '#65a30d', 'plus-circle'),
    ('Rent', 'Monthly rent or lease', '#0ea5e9', 'home'),
    ('Mortgage', 'Home loan EMI / mortgage payment', '#0284c7', 'landmark'),
    ('Home Maintenance', 'Repairs, cleaning, and upkeep', '#38bdf8', 'wrench'),
    ('Property Tax', 'Municipal or property taxes', '#0369a1', 'receipt'),
    ('Groceries', 'Supermarket and household groceries', '#f59e0b', 'shopping-cart'),
    ('Dining Out', 'Restaurants, cafes, and takeout', '#f97316', 'utensils'),
    ('Coffee & Snacks', 'Coffee shops and small treats', '#d97706', 'coffee'),
    ('Fuel', 'Petrol, diesel, or EV charging', '#6366f1', 'fuel'),
    ('Public Transit', 'Bus, metro, train, and passes', '#4f46e5', 'train'),
    ('Ride Hailing', 'Cab and bike taxi apps', '#818cf8', 'car'),
    ('Vehicle Maintenance', 'Service, repairs, parking, and tolls', '#4338ca', 'car-front'),
    ('Electricity', 'Power utility bills', '#eab308', 'zap'),
    ('Water', 'Water utility bills', '#06b6d4', 'droplets'),
    ('Internet', 'Home broadband and ISP', '#14b8a6', 'wifi'),
    ('Mobile Phone', 'Mobile plans and top-ups', '#0d9488', 'smartphone'),
    ('Gas', 'Cooking or heating gas', '#f43f5e', 'flame'),
    ('Healthcare', 'Doctor visits, pharmacy, and medical', '#ef4444', 'heart-pulse'),
    ('Fitness', 'Gym, sports, and wellness', '#fb7185', 'dumbbell'),
    ('Shopping', 'Clothes, electronics, and general retail', '#a855f7', 'shopping-bag'),
    ('Personal Care', 'Salon, grooming, and toiletries', '#c026d3', 'sparkles'),
    ('Entertainment', 'Movies, events, hobbies, and leisure', '#db2777', 'clapperboard'),
    ('Subscriptions', 'Streaming, software, and memberships', '#7c3aed', 'repeat'),
    ('Travel', 'Trips, hotels, and holiday spend', '#2563eb', 'plane'),
    ('Education', 'Courses, tuition, books, and training', '#1d4ed8', 'graduation-cap'),
    ('Insurance', 'Health, life, auto, and home premiums', '#64748b', 'shield'),
    ('Loan Payments', 'Personal loan, EMI, and debt service', '#475569', 'credit-card'),
    ('Savings', 'Transfers into savings goals', '#059669', 'piggy-bank'),
    ('Investments', 'SIP, brokerage, and investment transfers', '#047857', 'line-chart'),
    ('Transfers', 'Account-to-account transfers', '#334155', 'arrow-left-right'),
    ('Gifts & Donations', 'Gifts given and charitable giving', '#e11d48', 'gift'),
    ('Fees & Charges', 'Bank fees, penalties, and service charges', '#991b1b', 'circle-alert'),
    ('Miscellaneous', 'Uncategorized or one-off expenses', '#78716c', 'ellipsis')
) AS v(name, description, color, icon)
WHERE u.deleted_at IS NULL
ON CONFLICT (user_id, name) DO NOTHING;

-- Down Migration
DELETE FROM categories
WHERE is_system = TRUE
  AND name IN (
    'Salary',
    'Freelance',
    'Business Income',
    'Investments Income',
    'Other Income',
    'Rent',
    'Mortgage',
    'Home Maintenance',
    'Property Tax',
    'Groceries',
    'Dining Out',
    'Coffee & Snacks',
    'Fuel',
    'Public Transit',
    'Ride Hailing',
    'Vehicle Maintenance',
    'Electricity',
    'Water',
    'Internet',
    'Mobile Phone',
    'Gas',
    'Healthcare',
    'Fitness',
    'Shopping',
    'Personal Care',
    'Entertainment',
    'Subscriptions',
    'Travel',
    'Education',
    'Insurance',
    'Loan Payments',
    'Savings',
    'Investments',
    'Transfers',
    'Gifts & Donations',
    'Fees & Charges',
    'Miscellaneous'
  );
