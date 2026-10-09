/**
 * Server-owned content for the in-app guided tutorial. Web and the Android
 * app both render whatever this returns, so copy, order and targets can be
 * changed with a backend deploy alone (no web release, no APK).
 *
 * Targets are `data-tour="<id>"` anchors in the frontend. Each step names one
 * anchor for the desktop layout (sidebar) and one for the phone layout
 * (bottom bar / FAB). A step whose anchor is missing on the current screen is
 * shown as a centred card instead, so a stale id never breaks the tour.
 *
 * Task steps make the user do the thing for real (create an account, record
 * a transaction, set a budget) in the app's own forms. The tour steps aside
 * while the form is open and continues once the create succeeds. A task the
 * user's data already satisfies (see TutorialService facts) shows as done.
 *
 * Bump TUTORIAL_VERSION when the content changes meaningfully; it is stored
 * with each user's progress.
 */

export const TUTORIAL_KEY = 'getting-started';
export const TUTORIAL_VERSION = 2;

export type TutorialLayout = 'desktop' | 'mobile';
export type TutorialSurface = 'web' | 'native';
export type TutorialPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right';
export type TutorialAction =
  | { kind: 'navigate'; label: string; href: string }
  | { kind: 'new-transaction'; label: string };

export type TutorialTaskKind =
  | 'create-account'
  | 'create-transaction'
  | 'create-budget';

/** A hands-on step: the user completes it in the real form. */
export type TutorialTask = {
  kind: TutorialTaskKind;
  /** Primary button that opens the form. */
  label: string;
  /** Shown in the coach bar while the form is open. */
  hint: string;
  done_title: string;
  done_body: string;
  /** Shown when the user's data already satisfies the task. */
  already_done: string;
  /** Task that has to be satisfied first (offered before this one). */
  requires?: TutorialTaskKind;
  /** Checklist label on the final step. */
  checklist_label: string;
};

export type TutorialStep = {
  id: string;
  title: string;
  body: string;
  /** Short bullet points under the body. */
  tips?: string[];
  /** lucide icon key, resolved by the frontend (falls back to a default). */
  icon?: string;
  /** data-tour anchor per layout; omit for a centred card. */
  target?: Partial<Record<TutorialLayout, string>>;
  placement?: TutorialPlacement;
  /** Route to open before the step is shown. */
  route?: string;
  /** Limit the step to some surfaces / layouts (default: all). */
  surfaces?: TutorialSurface[];
  layouts?: TutorialLayout[];
  /** Buttons offered on the step (used on the final step). */
  actions?: TutorialAction[];
  task?: TutorialTask;
  /** Show the checklist of task steps (used on the final step). */
  checklist?: boolean;
};

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    icon: 'sparkles',
    title: 'Welcome to Opal',
    body: "Opal keeps your accounts, spending, plans and an AI advisor in one place. In the next few minutes you'll set things up for real: add your first account, record a transaction and set a budget.",
    tips: [
      'Use Next and Back, or the arrow keys on a keyboard.',
      'Skip for now and the tour comes back the next time you sign in.',
      'You can replay it anytime from Settings → Help & tutorial.',
    ],
  },
  {
    id: 'navigation',
    icon: 'compass',
    title: 'Getting around',
    body: 'Every module is listed here. Finance holds your money modules, and Workspace holds categories, documentation and settings.',
    route: '/dashboard',
    target: { desktop: 'nav-primary' },
    placement: 'right',
    layouts: ['desktop'],
  },
  {
    id: 'navigation-mobile',
    icon: 'compass',
    title: 'Getting around',
    body: 'The bar at the bottom takes you to Home, Transactions, the AI Advisor and Accounts. Tap More for every other module, including Budgets, Goals, Reports and Settings.',
    route: '/dashboard',
    target: { mobile: 'mobile-nav' },
    placement: 'top',
    layouts: ['mobile'],
  },
  {
    id: 'accounts',
    icon: 'wallet',
    title: 'Add your first account',
    body: "Accounts are the places your money lives: a bank account, cash, a card or a wallet. Let's add one now. Opal tracks its balance and adds it to your net worth.",
    tips: [
      'Use the balance it holds today as the opening balance.',
      'Credit cards and loans count as money you owe.',
    ],
    route: '/accounts',
    target: { desktop: 'nav-accounts', mobile: 'mobile-nav-accounts' },
    placement: 'right',
    task: {
      kind: 'create-account',
      label: 'Add my first account',
      hint: "Pick a type, give it a name like \"Savings\" or \"Cash\", enter today's balance, then save.",
      done_title: 'Account added',
      done_body:
        'Its balance now counts towards your net worth on the dashboard.',
      already_done:
        'You already have an account, so this step is done. You can add more anytime from Accounts.',
      checklist_label: 'Add an account',
    },
  },
  {
    id: 'new-transaction',
    icon: 'plus',
    title: 'Record your first transaction',
    body: 'Now log something you spent recently, like lunch or a cab ride. Choose the account you paid from and a category. The balance updates as soon as you save.',
    tips: [
      'Scan a bill or a UPI screenshot and Opal fills in the form for you.',
      'This button is always here. On a keyboard, Ctrl/⌘ + N opens it from anywhere.',
    ],
    route: '/accounts',
    target: { desktop: 'new-transaction', mobile: 'mobile-fab' },
    placement: 'right',
    task: {
      kind: 'create-transaction',
      label: 'Add my first transaction',
      hint: 'Enter the amount, pick the account and a category, then save.',
      done_title: 'First transaction recorded',
      done_body: 'The account balance has already been updated to match.',
      already_done:
        'You have already recorded transactions, so this step is done.',
      requires: 'create-account',
      checklist_label: 'Record a transaction',
    },
  },
  {
    id: 'transactions',
    icon: 'arrow-left-right',
    title: 'Review your transactions',
    body: 'Everything you record is listed here, newest first. Search, filter by account or category, and tap a row to edit or delete it.',
    route: '/expenses',
    target: { desktop: 'nav-expenses', mobile: 'mobile-nav-expenses' },
    placement: 'right',
  },
  {
    id: 'plan',
    icon: 'target',
    title: 'Set a budget',
    body: 'A budget caps what you spend in a category each month, like Food or Shopping. Opal tracks spending against it live and shows how much is left.',
    tips: [
      'Goals track savings for a target, and Recurring logs bills and salary on schedule.',
      'Reports turns all of this into charts and emailed summaries.',
    ],
    route: '/budgets',
    target: { desktop: 'nav-budgets', mobile: 'mobile-nav-more' },
    placement: 'right',
    task: {
      kind: 'create-budget',
      label: 'Create a budget',
      hint: 'Choose a category you spend on often, set a monthly limit, then save.',
      done_title: 'Budget set',
      done_body: "You'll see how much is left in it every time you spend.",
      already_done: 'You already have a budget, so this step is done.',
      checklist_label: 'Set a budget',
    },
  },
  {
    id: 'ai-advisor',
    icon: 'sparkles',
    title: 'Ask the AI Advisor',
    body: 'Ask questions about your money in plain words, like "Where did I overspend last month?". It can also draft transactions for you, and nothing is saved until you confirm it.',
    target: { desktop: 'nav-ai', mobile: 'mobile-nav-ai' },
    placement: 'right',
  },
  {
    id: 'search',
    icon: 'search',
    title: 'Find anything fast',
    body: 'Search jumps to any module, transaction, account or goal, and runs quick commands such as "New transaction" or "Scan receipt".',
    tips: ['On a keyboard, press Ctrl/⌘ + K.'],
    target: { desktop: 'topbar-search', mobile: 'topbar-search' },
    placement: 'bottom',
  },
  {
    id: 'sync',
    icon: 'cloud',
    title: 'Works offline',
    body: 'You can keep adding and editing while offline. Changes wait on your device and sync automatically when you reconnect. This icon shows the sync status.',
    target: { desktop: 'topbar-sync', mobile: 'topbar-sync' },
    placement: 'bottom',
  },
  {
    id: 'settings',
    icon: 'settings',
    title: 'Make it yours',
    body: 'Settings has your profile, currency and date formats, themes, AI providers and data export. Help & tutorial in Settings replays this tour.',
    target: { desktop: 'nav-settings', mobile: 'mobile-nav-more' },
    placement: 'right',
  },
  {
    id: 'finish',
    icon: 'party',
    title: "You're all set",
    body: 'Keep recording as you spend and Opal will show where your money goes. You can replay this tour anytime from Settings → Help & tutorial.',
    route: '/dashboard',
    checklist: true,
    actions: [
      { kind: 'new-transaction', label: 'Add another transaction' },
      { kind: 'navigate', label: 'Ask the AI Advisor', href: '/ai' },
    ],
  },
];
